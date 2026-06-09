const admin = require("firebase-admin");
const axios = require("axios");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

async function checkAlarms() {
  const db = admin.firestore();
  const usersSnapshot = await db.collection("users").get();

  for (const userDoc of usersSnapshot.docs) {
    const userData = userDoc.data();
    const fcmToken = userData.fcmToken;
    if (!fcmToken) continue;

    const tickersSnapshot = await userDoc.ref.collection("tickers").get();
    if (tickersSnapshot.empty) continue;

    for (const tickerDoc of tickersSnapshot.docs) {
      const tickerData = tickerDoc.data();
      const { symbol, displayName, alarms } = tickerData;
      const crossingState = tickerData.crossingState || {};

      if (!symbol || !alarms || alarms.length === 0) continue;

      // Determine which indicators are needed for this ticker
      const needsRSI = alarms.some(a => a.indicator === "rsi" && a.enabled);
      const needsRVI = alarms.some(a => a.indicator === "rvi" && a.enabled);

      if (!needsRSI && !needsRVI) continue;

      // Fetch close prices once per ticker (symbol includes exchange suffix, e.g. "SAP.DE")
      const closes = await fetchCloses(symbol);
      if (!closes) continue;

      const rsi = needsRSI ? calculateRSI(closes, 14) : null;
      const rvi = needsRVI ? calculateRVI(closes, 14) : null;

      console.log(`${symbol}: RSI=${rsi !== null ? rsi.toFixed(1) : "n/a"}, RVI=${rvi !== null ? rvi.toFixed(1) : "n/a"}`);

      const newCrossingState = { ...crossingState };
      let stateChanged = false;

      for (const alarm of alarms) {
        if (!alarm.enabled) continue;

        const { indicator, direction, threshold } = alarm;
        const stateKey = `${indicator}_${direction}`;
        const currentValue = indicator === "rsi" ? rsi : rvi;

        if (currentValue === null || threshold === undefined) continue;

        const isTriggered = direction === "above"
          ? currentValue > threshold
          : currentValue < threshold;

        const wasTriggered = crossingState[stateKey] === true;

        // Only notify on fresh crossing (transition from normal → triggered)
        if (isTriggered && !wasTriggered) {
          const name = displayName || symbol;
          const indicatorLabel = indicator.toUpperCase();
          const directionLabel = direction === "above" ? "überschritten" : "unterschritten";

          try {
            await admin.messaging().send({
              token: fcmToken,
              notification: {
                title: name,
                body: `${indicatorLabel} bei ${currentValue.toFixed(1)} – Limit ${directionLabel}`
              },
              data: { symbol, indicator, direction }
            });
            console.log(`✓ Alarm gesendet: ${symbol} ${indicatorLabel} ${currentValue.toFixed(1)} ${direction} ${threshold}`);
          } catch (e) {
            console.error(`✗ FCM-Fehler für ${symbol}:`, e.message);
          }
        }

        // Update crossing state if changed
        if (newCrossingState[stateKey] !== isTriggered) {
          newCrossingState[stateKey] = isTriggered;
          stateChanged = true;
        }
      }

      // Write state back to Firestore only if something changed
      if (stateChanged) {
        await tickerDoc.ref.update({ crossingState: newCrossingState });
      }
    }
  }

  // Heartbeat
  await db.collection("status").doc("scheduler").set({
    lastRun: admin.firestore.FieldValue.serverTimestamp(),
    status: "ok"
  });
  console.log("Scheduler Timestamp aktualisiert");
}

// Fetch daily close prices from Yahoo Finance
// symbol must be the full Yahoo Finance symbol including exchange suffix (e.g. "SAP.DE", "IWDA.AS", "AAPL")
async function fetchCloses(symbol) {
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,
      { params: { interval: "1d", range: "3mo" } }
    );
    const closes = data.chart.result[0].indicators.quote[0].close;
    return closes.filter(c => c !== null && c !== undefined);
  } catch (e) {
    console.error(`Fehler beim Abruf von ${symbol}:`, e.message);
    return null;
  }
}

// Wilder's RSI (period = 14)
function calculateRSI(closes, period) {
  if (closes.length < period + 1) return null;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// Relative Volatility Index (Dorsey, period = 14)
// Uses Wilder smoothing on per-bar standard deviations, split by up/down days
function calculateRVI(closes, period) {
  if (closes.length < period * 2 + 1) return null;

  // Compute standard deviation and direction for each bar from index `period` onward
  const entries = [];
  for (let i = period; i < closes.length; i++) {
    const slice = closes.slice(i - period, i);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    const isUp = closes[i] >= closes[i - 1];
    entries.push({ std, isUp });
  }

  if (entries.length < period) return null;

  // Seed with simple average for first period
  let avgUp = 0, avgDown = 0;
  for (let i = 0; i < period; i++) {
    if (entries[i].isUp) avgUp += entries[i].std;
    else avgDown += entries[i].std;
  }
  avgUp /= period;
  avgDown /= period;

  // Wilder smoothing for remaining entries
  for (let i = period; i < entries.length; i++) {
    const stdUp   = entries[i].isUp ? entries[i].std : 0;
    const stdDown = entries[i].isUp ? 0 : entries[i].std;
    avgUp   = (avgUp   * (period - 1) + stdUp)   / period;
    avgDown = (avgDown * (period - 1) + stdDown) / period;
  }

  if (avgUp + avgDown === 0) return 50;
  return 100 * avgUp / (avgUp + avgDown);
}

checkAlarms().then(() => process.exit(0));
