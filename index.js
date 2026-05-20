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
    const tickers = await userDoc.ref.collection("tickers").get();

    for (const tickerDoc of tickers.docs) {
      const { symbol, alarms } = tickerDoc.data();
      const rsi = await fetchRSI(symbol);
      if (rsi === null) continue;

      for (const alarm of alarms || []) {
        const triggered = alarm.direction === "below"
          ? rsi < alarm.rsi
          : rsi > alarm.rsi;

        if (triggered && fcmToken) {
          await admin.messaging().send({
            token: fcmToken,
            notification: {
              title: `${symbol} RSI Alarm`,
              body: `RSI ist ${alarm.direction === "below" ? "unter" : "über"} ${alarm.rsi} (aktuell: ${rsi.toFixed(1)})`
            },
            data: { symbol, tickerID: tickerDoc.id }
          });
          console.log(`Alarm gesendet: ${symbol} RSI ${rsi.toFixed(1)}`);
        }
      }
    }
  }

  // Timestamp in Firestore schreiben nach jedem Lauf
  await db.collection("status").doc("scheduler").set({
    lastRun: admin.firestore.FieldValue.serverTimestamp(),
    status: "ok"
  });
  console.log("Scheduler Timestamp aktualisiert");
}

async function fetchRSI(symbol) {
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,
      { params: { interval: "1d", range: "3mo" } }
    );
    const closes = data.chart.result[0].indicators.quote[0].close;
    return calculateRSI(closes, 14);
  } catch (e) {
    console.error(`Fehler bei ${symbol}:`, e.message);
    return null;
  }
}

function calculateRSI(closes, period) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

checkAlarms().then(() => process.exit(0));
