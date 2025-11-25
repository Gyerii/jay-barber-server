const admin = require('firebase-admin');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Firebase Admin Initialization - WITH CORRECT KEY
const serviceAccount = {
  "type": "service_account",
  "project_id": "jay-the-barber",
  "private_key_id": "c900c766f91d3fad46c087e8e37a508fc7a82f15",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCPDcNocjLCBeSq\nHIY5Mktg20Dcbp9hj1++KAwS3Sa7lqvS/0pntoneVToOjoMKnohPJ5/LCjRWb9Kd\nIVqpP1Um97MKTTGPsSY8Vh58PCGjRNeeXUUu5Egmw69GGsovndytxAf9IKoiDWDb\n7o6SPfGayfqgEKKaumYOvZrm4vW30Kl5rMVRh7+cmw00E2r4lC0vNtSmlZeIByqr\nUQCEnAVdmvlHF4cNxc+fgx0dj9jdDQ3pkuwF5hqJWHxFms+g5UzSMxg0KIrfQg5t\nUsKCvcII/92oeX1Z5JLATSEHRjpaJQEvIk6laWvqHOyTA/SN056DMyzGyIt5a59j\n6zfcuy4fAgMBAAECggEADAOb5amxmZnlGmRK4YLX0cqYJ+sid48S+2VhnjP0jMya\noZ3PIeayrXl65r4RQ1MNH5i0UtkIjDnX9lpWwuAOxrcG0lapUugNzgNtjAGA0bV2\nZlZu+QEzDg5hKgIV+OnJHs7X3OphX3rAJ7hhQOby440S/15mSZhd+d7yo3FsMYO0\njOIOjRcvDBr2ySTF4HFYZ6rBTQMOdIvw7B53dJvgUukHV2TBqiHCL0lnmcRE16Nb\nSDNAVVtkYDg86EU17bOt+RoX4fGy8lIjBd0jp0SsgYjY24j2t4bMeWuSrmdMBiCx\nL5RVr2eXN/kqNt8RRvyPnLcUCWkzRT5FAkDBwCNsAQKBgQDHATxex7JlXqewLRvf\nCXw90BZ4t2F3jFdqPfgglciMuFk3taNvuMuwbSs+DLB3VKrVIa7Yj05614F8CMIZ\nthMyH4V/YWkBQnaaPyDMuJiA6zAT1jm8UltHZxf9oO/5z93ZUqaO/BCQoCFop+sI\n7MYONjAU7yeL6Xg+hbxcr8LGswKBgQC4BkVzOq7Vn7exrGICwtnBjpt6FbLY7o1D\nxe8IuFhzfh/KepCxbh7CH/GY9wSnrTYt0x82yKbMjMm9PL9998To/Li2xmVDeNZe\nOhg3ErA92dd9teKgQy/OUKWxE0SmnQkMUFHUUyXxooXVCG7d88IYDjB0GT7riqt1\nrkl17LrQ5QKBgEXZZjIyT6iK97q7qou3jZc4oZqPazOF2+zbgWsWh8T0s8P9Cjed\nmkj7mHD4DTxlSGz0nKVAb6BoYfeCL3bM1KIENFxIeY3KoUx0mfOhW03svvxHdg5m\nrck7I02PnouFbW3pN7L6QGoy+mb8gV+pk77LQEcoxi2yrdTsJfg2bNxHAoGAa7AH\nzjGGBC6t4UQeKr15jkH0i9HM0hNvCTz372NpJ1SkJ+nnaF0nlLP6vme3CqRa8x/7\nwSRUL5knqRy2dnGagjj5osOgmIZK8+MNLpU6G0eySbc5Qk1u2U3qWCANaW61z8Xk\nzNpHdwqDRLHlpu6xI0CSbC4l2tJQGdJ+3IpGnF0CgYEApdBcl1Q5qwH5MOZi5+vi\niL+n36yaH8YbCiz9e5I85O9QKEsImykCkkTDfcVz63tIFONFOxYYpbUQ2EnJShVK\nrrGubOiVPbVLNSGe1wICMDMBGbQoJYC3ERPq1/SYju+EwWKHZd9VRczDQbMo/giK\nbjxnoKaDPGdVmT0JE6397Qw=\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@jay-the-barber.iam.gserviceaccount.com",
  "client_id": "111495719098512047124",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40jay-the-barber.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
};

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin initialized successfully for project: jay-the-barber');
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error);
}

const db = admin.firestore();
const messaging = admin.messaging();

// Health Check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Online 🟢', 
    message: 'Notification Server is Running!',
    project: 'jay-the-barber',
    timestamp: new Date().toISOString()
  });
});

// Store FCM Token endpoint
app.post('/store-token', async (req, res) => {
  try {
    const { userId, token, deviceInfo } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'FCM token is required'
      });
    }

    const tokenData = {
      token: token,
      userId: userId || 'anonymous',
      deviceInfo: deviceInfo || {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      isActive: true
    };

    // Store using token as document ID
    await db.collection('fcm_tokens').doc(token).set(tokenData);

    console.log('✅ FCM token stored for user:', userId || 'anonymous');
    res.json({
      success: true,
      message: 'FCM token stored successfully'
    });

  } catch (error) {
    console.error('❌ Error storing token:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test Firestore connection
app.get('/test-firestore', async (req, res) => {
  try {
    // Test write operation
    const testDoc = db.collection('server_tests').doc('connection_test');
    await testDoc.set({
      message: 'Firestore connection successful',
      timestamp: new Date().toISOString(),
      project: 'jay-the-barber'
    });

    // Test read operation - count tokens
    const tokensSnapshot = await db.collection('fcm_tokens').get();
    
    res.json({
      success: true,
      firestore: 'Connected ✅',
      tokensCount: tokensSnapshot.size,
      project: 'jay-the-barber'
    });
  } catch (error) {
    console.error('❌ Firestore test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code
    });
  }
});

// Get token count
app.get('/token-count', async (req, res) => {
  try {
    const tokensSnapshot = await db.collection('fcm_tokens').get();
    const activeTokens = tokensSnapshot.size;
    
    res.json({
      success: true,
      activeTokens: activeTokens,
      message: activeTokens === 0 
        ? 'No FCM tokens stored yet'
        : `${activeTokens} devices registered`
    });
  } catch (error) {
    console.error('❌ Error getting token count:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Main notification endpoint
app.post('/send-to-all', async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        error: 'Title and body are required'
      });
    }

    console.log(`📢 Starting broadcast: "${title}"`);

    // Get all tokens from Firestore
    let tokensSnapshot;
    try {
      tokensSnapshot = await db.collection('fcm_tokens').get();
    } catch (firestoreError) {
      console.error('❌ Firestore error:', firestoreError);
      return res.status(500).json({
        success: false,
        error: 'Firestore connection failed: ' + firestoreError.message
      });
    }

    const tokens = [];
    tokensSnapshot.forEach(doc => {
      const tokenData = doc.data();
      if (tokenData.token) {
        tokens.push(tokenData.token);
      }
    });

    console.log(`📱 Found ${tokens.length} tokens in database`);

    if (tokens.length === 0) {
      return res.json({
        success: true,
        successCount: 0,
        failureCount: 0,
        totalDevices: 0,
        message: 'No devices registered for notifications yet'
      });
    }

    // Send notifications
    const message = {
      notification: {
        title: title,
        body: body
      },
      tokens: tokens
    };

    console.log(`📤 Sending to ${tokens.length} devices...`);
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
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 ========================================');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 External URL: https://jay-barber-notifications.onrender.com`);
  console.log(`🔥 Firebase Project: jay-the-barber`);
  console.log('========================================\n');
});

