const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin with environment variables
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const envVar = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
    serviceAccount = JSON.parse(envVar);
    console.log('✅ Using Firebase credentials from environment variable');
  } catch (error) {
    console.error('❌ Error parsing Firebase credentials:', error);
    process.exit(1);
  }
} else {
  try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log('✅ Using Firebase credentials from local file');
  } catch (error) {
    console.error('❌ serviceAccountKey.json not found and no environment variable set');
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const userTokens = new Map();

console.log('🚀 Firebase Admin initialized');

// Store token - ONE per user
app.post('/store-token', async (req, res) => {
  try {
    const { token, userId, role, deviceInfo } = req.body;

    if (!token || !userId) {
      return res.status(400).json({ 
        error: 'Token and userId required'
      });
    }

    // More lenient token validation
    if (typeof token !== 'string' || token.length < 50) {
      return res.status(400).json({
        error: 'Invalid token format'
      });
    }

    // Store in memory
    userTokens.set(userId, {
      token,
      userId,
      role: role || 'user',
      deviceInfo: deviceInfo || {},
      lastUpdated: new Date().toISOString()
    });

    // Store in Firestore
    await db.collection('fcm_tokens').doc(userId).set({
      token,
      userId,
      role: role || 'user',
      platform: deviceInfo?.platform || 'unknown',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`✅ Token stored for: ${userId} (${role || 'user'})`);
    console.log(`📊 Total unique users: ${userTokens.size}`);

    res.status(200).json({ 
      success: true,
      userId,
      uniqueUsers: userTokens.size
    });

  } catch (error) {
    console.error('❌ Store error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove token
app.post('/remove-token', async (req, res) => {
  try {
    const { token, userId } = req.body;

    if (userId) {
      userTokens.delete(userId);
      await db.collection('fcm_tokens').doc(userId).delete();
      console.log(`🗑️ Removed: ${userId}`);
    }

    console.log(`📊 Remaining users: ${userTokens.size}`);

    res.status(200).json({ 
      success: true,
      remainingUsers: userTokens.size
    });

  } catch (error) {
    console.error('❌ Remove error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user count
app.get('/token-count', async (req, res) => {
  try {
    const snapshot = await db.collection('fcm_tokens').get();
    
    userTokens.clear();
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.userId && data.token) {
        userTokens.set(data.userId, {
          token: data.token,
          userId: data.userId,
          role: data.role || 'user',
          deviceInfo: {},
          lastUpdated: data.updatedAt
        });
      }
    });

    const uniqueUsers = userTokens.size;

    console.log(`📊 Unique users: ${uniqueUsers}`);

    res.status(200).json({ 
      activeTokens: uniqueUsers,
      uniqueUsers: uniqueUsers,
      totalDevices: snapshot.size
    });

  } catch (error) {
    console.error('❌ Count error:', error);
    res.status(500).json({ error: error.message });
  }
});

// More lenient token validation
function validateTokens(tokens) {
  const validTokens = [];
  const invalidTokens = [];
  
  tokens.forEach(token => {
    // More lenient validation - just check if it's a string and has reasonable length
    if (typeof token === 'string' && token.length > 10) {
      validTokens.push(token);
    } else {
      invalidTokens.push(token);
    }
  });
  
  if (invalidTokens.length > 0) {
    console.log(`⚠️ Invalid tokens found: ${invalidTokens.length}`);
  }
  
  return validTokens;
}

// Enhanced notification with custom messages AND COLORS
app.post('/send-shop-status', async (req, res) => {
  try {
    const { isOpen } = req.body;

    if (typeof isOpen !== 'boolean') {
      return res.status(400).json({ error: 'isOpen boolean required' });
    }

    // Get unique tokens from Firestore
    const snapshot = await db.collection('fcm_tokens').get();
    const uniqueTokens = [];
    const userIds = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.token && data.userId) {
        uniqueTokens.push(data.token);
        userIds.push(data.userId);
      }
    });

    // Validate tokens with lenient validation
    const validTokens = validateTokens(uniqueTokens);

    if (validTokens.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No valid users to notify',
        successCount: 0,
        failureCount: 0
      });
    }

    // Enhanced message content with emojis
    const title = isOpen ? '🏪 Shop is Now OPEN!' : '🚪 Shop is Now CLOSED';
    const body = isOpen 
      ? 'Great news! We are now open and ready to serve you with fresh haircuts and styling services. Come visit us for your grooming needs! 💈✂️'
      : 'Thank you for your visit today! We are now closed and will reopen tomorrow with fresh energy and great service. See you soon! 👋✨';

    // Colors for notifications - Green for OPEN, Red for CLOSED
    const notificationColor = isOpen ? '#10B981' : '#EF4444';

    console.log(`📤 Sending shop ${isOpen ? 'OPEN' : 'CLOSED'} to ${validTokens.length} users`);
    console.log(`🎨 Notification color: ${notificationColor}`);

    // Enhanced message with colors
    const message = {
      notification: { 
        title, 
        body
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          priority: 'high',
          tag: 'shop_status',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          color: notificationColor,
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          }
        }
      },
      data: {
        type: 'shop_status',
        status: isOpen ? 'open' : 'closed',
        timestamp: new Date().toISOString(),
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        notification_color: notificationColor,
        is_open: isOpen.toString()
      },
      tokens: validTokens
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);

      console.log(`✅ Shop status sent - Success: ${response.successCount}, Failed: ${response.failureCount}`);
      console.log(`🎨 Color applied: ${isOpen ? 'GREEN (Open)' : 'RED (Closed)'}`);

      // Only remove tokens for specific critical errors
      if (response.failureCount > 0) {
        const tokensToRemove = [];
        
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errorCode = resp.error?.code;
            console.log(`❌ Token ${idx}: ${errorCode}`);
            
            // Only remove for these specific errors
            if (errorCode === 'messaging/invalid-registration-token' ||
                errorCode === 'messaging/registration-token-not-registered') {
              tokensToRemove.push({
                token: validTokens[idx],
                userId: userIds[idx]
              });
            }
          }
        });

        // Remove invalid tokens
        for (const { token, userId } of tokensToRemove) {
          if (userId) {
            userTokens.delete(userId);
            await db.collection('fcm_tokens').doc(userId).delete();
            console.log(`🗑️ Removed invalid token for user: ${userId}`);
          }
        }
      }

      res.status(200).json({
        success: true,
        status: isOpen ? 'open' : 'closed',
        successCount: response.successCount,
        failureCount: response.failureCount,
        totalUsers: validTokens.length,
        notificationColor: notificationColor,
        message: `Shop ${isOpen ? 'opened' : 'closed'} notification sent`
      });

    } catch (sendError) {
      console.error('❌ Send operation error:', sendError);
      res.status(500).json({ 
        error: 'Failed to send notifications',
        details: sendError.message 
      });
    }

  } catch (error) {
    console.error('❌ Shop status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Simple send endpoint for testing
app.post('/send-test-notification', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const message = {
      notification: {
        title: '🔧 Test Notification',
        body: 'This is a test notification from the server! ✅'
      },
      token: token
    };

    const response = await admin.messaging().send(message);
    
    console.log('✅ Test notification sent successfully');
    res.status(200).json({
      success: true,
      message: 'Test notification sent',
      messageId: response
    });

  } catch (error) {
    console.error('❌ Test notification error:', error);
    res.status(500).json({ 
      error: 'Failed to send test notification',
      details: error.message 
    });
  }
});

// Debug endpoint to check all tokens
app.get('/debug-tokens', async (req, res) => {
  try {
    const snapshot = await db.collection('fcm_tokens').get();
    const tokens = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      tokens.push({
        userId: data.userId,
        tokenPreview: data.token ? `${data.token.substring(0, 30)}...` : 'MISSING',
        tokenLength: data.token ? data.token.length : 0,
        role: data.role,
        updatedAt: data.updatedAt
      });
    });

    res.status(200).json({
      totalTokens: snapshot.size,
      uniqueUsers: userTokens.size,
      tokens: tokens
    });
  } catch (error) {
    console.error('❌ Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'Server running',
    uniqueUsers: userTokens.size,
    timestamp: new Date().toISOString(),
    features: {
      coloredNotifications: true,
      openColor: '#10B981',
      closedColor: '#EF4444'
    }
  });
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Notification service ready`);
  console.log(`🎨 Colors: OPEN = Green (#10B981), CLOSED = Red (#EF4444)`);
  
  syncTokens();
});

// Sync tokens from Firestore on startup
async function syncTokens() {
  try {
    const snapshot = await db.collection('fcm_tokens').get();
    
    userTokens.clear();
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.userId && data.token) {
        userTokens.set(data.userId, {
          token: data.token,
          userId: data.userId,
          role: data.role || 'user',
          deviceInfo: {},
          lastUpdated: data.updatedAt
        });
      }
    });
    
    console.log(`✅ Synced ${userTokens.size} unique users from Firestore`);
    
  } catch (error) {
    console.error('❌ Sync error:', error);
  }
}

process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});
