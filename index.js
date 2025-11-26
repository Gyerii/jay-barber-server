const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Memory storage for quick access
const userTokens = new Map(); // userId -> token

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

    // Store in memory - overwrites if user already exists
    userTokens.set(userId, {
      token,
      userId,
      role: role || 'user',
      deviceInfo: deviceInfo || {},
      lastUpdated: new Date().toISOString()
    });

    // Store in Firestore with userId as document ID
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
    } else if (token) {
      // Find by token
      for (let [key, value] of userTokens.entries()) {
        if (value.token === token) {
          userTokens.delete(key);
          await db.collection('fcm_tokens').doc(key).delete();
          console.log(`🗑️ Removed by token: ${key}`);
          break;
        }
      }
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
    // Sync with Firestore
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

// Send to unique users - NO DUPLICATES
app.post('/send-to-unique-users', async (req, res) => {
  try {
    const { title, body, tokens, userIds } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body required' });
    }

    let uniqueTokens = [];

    if (tokens && Array.isArray(tokens)) {
      // Use provided tokens (already unique)
      uniqueTokens = [...new Set(tokens)];
    } else {
      // Get from Firestore
      const snapshot = await db.collection('fcm_tokens').get();
      const tokenSet = new Set();

      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.token && data.userId) {
          tokenSet.add(data.token);
        }
      });

      uniqueTokens = Array.from(tokenSet);
    }

    if (uniqueTokens.length === 0) {
      console.log('⚠️ No tokens to send');
      return res.status(200).json({
        success: true,
        successCount: 0,
        failureCount: 0,
        message: 'No registered users'
      });
    }

    console.log(`📤 Sending to ${uniqueTokens.length} unique users...`);

    // Prepare message
    const message = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          priority: 'max',
          tag: 'shop_status',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1
          }
        }
      },
      tokens: uniqueTokens
    };

    // Send notification
    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`✅ Success: ${response.successCount}`);
    console.log(`❌ Failed: ${response.failureCount}`);

    // Remove invalid tokens
    if (response.failureCount > 0) {
      const tokensToRemove = [];
      
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          console.log(`❌ Token ${idx}: ${errorCode}`);
          
          if (errorCode === 'messaging/invalid-registration-token' ||
              errorCode === 'messaging/registration-token-not-registered') {
            tokensToRemove.push(uniqueTokens[idx]);
          }
        }
      });

      // Clean up invalid tokens
      for (const token of tokensToRemove) {
        for (let [userId, data] of userTokens.entries()) {
          if (data.token === token) {
            userTokens.delete(userId);
            await db.collection('fcm_tokens').doc(userId).delete();
            console.log(`🗑️ Cleaned invalid token: ${userId}`);
            break;
          }
        }
      }
    }

    res.status(200).json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      uniqueUsers: uniqueTokens.length
    });

  } catch (error) {
    console.error('❌ Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Legacy endpoint - redirects to unique users
app.post('/send-to-all', async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body required' });
    }

    // Get unique tokens from Firestore
    const snapshot = await db.collection('fcm_tokens').get();
    const uniqueTokens = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.token && data.userId) {
        uniqueTokens.push(data.token);
      }
    });

    if (uniqueTokens.length === 0) {
      return res.status(200).json({
        success: true,
        successCount: 0,
        failureCount: 0,
        totalDevices: 0
      });
    }

    const message = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          tag: 'shop_status'
        }
      },
      tokens: uniqueTokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`✅ Legacy: Sent to ${response.successCount} users`);

    res.status(200).json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      totalDevices: uniqueTokens.length
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'Server running',
    uniqueUsers: userTokens.size,
    timestamp: new Date().toISOString()
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Notification service ready`);
  console.log(`👥 Unique users: ${userTokens.size}`);
  
  // Sync tokens on startup
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

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});
