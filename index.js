// ============================
// IMPORTS
// ============================
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config(); // Load .env variables

const app = express();

// ============================
// MIDDLEWARE
// ============================
app.use(cors());
app.use(bodyParser.json());

// ============================
// FIREBASE ADMIN INITIALIZATION
// ============================

// Load service account from environment variable
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON is missing in environment variables.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (err) {
  console.error('❌ Invalid FIREBASE_SERVICE_ACCOUNT_JSON:', err);
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin initialized successfully!');
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error);
  process.exit(1);
}

const db = admin.firestore();
const messaging = admin.messaging();

// ============================
// HEALTH CHECK
// ============================
app.get('/', (req, res) => {
  res.json({
    status: 'Online 🟢',
    message: 'Notification Server is Running!',
    timestamp: new Date().toISOString()
  });
});

// ============================
// STORE FCM TOKEN
// ============================
app.post('/store-token', async (req, res) => {
  try {
    const { userId, token, deviceInfo } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'FCM token is required' });

    const tokenData = {
      token,
      userId: userId || 'anonymous',
      deviceInfo: deviceInfo || {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      isActive: true
    };

    await db.collection('fcm_tokens').doc(token).set(tokenData);
    console.log(`✅ FCM token stored for user: ${userId || 'anonymous'}`);

    res.json({ success: true, message: 'FCM token stored successfully' });
  } catch (error) {
    console.error('❌ Error storing token:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================
// TEST FIRESTORE CONNECTION
// ============================
app.get('/test-firestore', async (req, res) => {
  try {
    await db.collection('server_tests').doc('connection_test').set({
      message: 'Firestore connection successful',
      timestamp: new Date().toISOString()
    });

    const tokensSnapshot = await db.collection('fcm_tokens').get();

    res.json({
      success: true,
      firestore: 'Connected ✅',
      tokensCount: tokensSnapshot.size
    });
  } catch (error) {
    console.error('❌ Firestore test failed:', error);
    res.status(500).json({ success: false, error: error.message, code: error.code });
  }
});

// ============================
// GET TOKEN COUNT
// ============================
app.get('/token-count', async (req, res) => {
  try {
    const tokensSnapshot = await db.collection('fcm_tokens').get();
    const activeTokens = tokensSnapshot.size;

    res.json({
      success: true,
      activeTokens,
      message: activeTokens === 0
        ? 'No FCM tokens stored yet'
        : `${activeTokens} devices registered`
    });
  } catch (error) {
    console.error('❌ Error getting token count:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================
// SEND NOTIFICATIONS TO ALL
// ============================
app.post('/send-to-all', async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ success: false, error: 'Title and body are required' });

    const tokensSnapshot = await db.collection('fcm_tokens').get();
    const tokens = tokensSnapshot.docs.map(doc => doc.data().token).filter(Boolean);

    if (tokens.length === 0) {
      return res.json({ success: true, successCount: 0, failureCount: 0, totalDevices: 0, message: 'No devices registered for notifications yet' });
    }

    const message = { notification: { title, body }, tokens };
    const response = await messaging.sendEachForMulticast(message);

    console.log(`✅ Broadcast completed: ${response.successCount} success, ${response.failureCount} failed`);
    res.json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      totalDevices: tokens.length,
      message: `Sent to ${response.successCount} of ${tokens.length} devices`
    });
  } catch (error) {
    console.error('❌ Error in send-to-all:', error);
    res.status(500).json({ success: false, error: error.message, code: error.code });
  }
});

// ============================
// SERVER START
// ============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
