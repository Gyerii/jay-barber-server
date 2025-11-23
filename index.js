require('dotenv').config();
const admin = require('firebase-admin');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

// Import the service account key
// For Render: read from environment variable
// For local: read from file
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
});

// Firestore reference
const db = admin.firestore();
const messaging = admin.messaging();

// Express setup
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Test endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'Server is running',
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test Firestore connection
    await db.collection('shop_status').doc('current').get();
    res.json({
      status: 'healthy',
      firestore: 'connected',
      fcm: 'ready',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Endpoint to send notification to a single device
app.post('/send-notification', async (req, res) => {
  try {
    const { token, title, body } = req.body;

    if (!token || !title || !body) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: token, title, body',
      });
    }

    const message = {
      notification: {
        title: title,
        body: body,
      },
      token: token,
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          priority: 'high',
        },
      },
    };

    const response = await messaging.send(message);
    
    console.log('✅ Notification sent successfully:', response);
    res.status(200).json({
      success: true,
      messageId: response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Error sending notification:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      errorCode: error.code,
      timestamp: new Date().toISOString(),
    });
  }
});

// Endpoint to send notification to ALL users
app.post('/send-to-all', async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: title, body',
      });
    }

    // Get all FCM tokens from Firestore
    const tokensSnapshot = await db.collection('fcm_tokens').get();

    if (tokensSnapshot.empty) {
      return res.status(404).json({
        success: false,
        error: 'No FCM tokens found in database',
        timestamp: new Date().toISOString(),
      });
    }

    const tokens = [];
    const invalidTokens = [];

    tokensSnapshot.forEach((doc) => {
      const token = doc.data().token;
      if (token) {
        tokens.push(token);
      }
    });

    console.log(`📤 Sending notifications to ${tokens.length} devices...`);

    // Send to all tokens (batch processing)
    const sendPromises = tokens.map(async (token) => {
      try {
        const message = {
          notification: {
            title: title,
            body: body,
          },
          token: token,
          android: {
            priority: 'high',
            notification: {
              channelId: 'shop_status_channel',
              sound: 'default',
              priority: 'high',
            },
          },
        };

        const response = await messaging.send(message);
        return { success: true, token, messageId: response };
      } catch (error) {
        console.error(`Failed to send to token ${token}:`, error.message);
        
        // If token is invalid, mark it for removal
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
          invalidTokens.push(token);
        }
        
        return { success: false, token, error: error.message };
      }
    });

    const results = await Promise.all(sendPromises);
    
    // Remove invalid tokens from Firestore
    if (invalidTokens.length > 0) {
      console.log(`🗑️  Removing ${invalidTokens.length} invalid tokens...`);
      const deletePromises = invalidTokens.map(async (token) => {
        const tokenDocs = await db.collection('fcm_tokens')
          .where('token', '==', token)
          .get();
        
        const deletions = tokenDocs.docs.map((doc) => doc.ref.delete());
        return Promise.all(deletions);
      });
      
      await Promise.all(deletePromises);
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    console.log(`✅ Sent: ${successCount} | ❌ Failed: ${failureCount}`);

    res.status(200).json({
      success: true,
      totalTokens: tokens.length,
      successCount,
      failureCount,
      invalidTokensRemoved: invalidTokens.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Error in send-to-all:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Endpoint to test with specific shop status
app.post('/notify-shop-status', async (req, res) => {
  try {
    const { isOpen } = req.body;

    if (typeof isOpen !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'isOpen must be a boolean value',
      });
    }

    const title = isOpen ? '🟢 Shop is Now OPEN!' : '🔴 Shop is Now CLOSED';
    const body = isOpen
      ? 'We are ready to serve you! Come visit us today.'
      : 'Thank you for your patronage. See you next time!';

    // Forward to send-to-all endpoint
    const response = await fetch(`http://localhost:${PORT}/send-to-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('❌ Error in notify-shop-status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Get all registered tokens (for debugging)
app.get('/tokens', async (req, res) => {
  try {
    const tokensSnapshot = await db.collection('fcm_tokens').get();
    const tokens = [];

    tokensSnapshot.forEach((doc) => {
      tokens.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.json({
      success: true,
      count: tokens.length,
      tokens: tokens,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: error.message,
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 ========================================');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`📱 Send notification: POST http://localhost:${PORT}/send-to-all`);
  console.log('========================================\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully...');
  process.exit(0);
});