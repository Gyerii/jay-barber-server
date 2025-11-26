const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin with environment variables
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Production: Use environment variable (Render.com)
  try {
    const envVar = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
    serviceAccount = JSON.parse(envVar);
    console.log('✅ Using Firebase credentials from environment variable');
  } catch (error) {
    console.error('❌ Error parsing Firebase credentials:', error);
    process.exit(1);
  }
} else {
  // Development: Use local file
  try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log('✅ Using Firebase credentials from local file');
  } catch (error) {
    console.error('❌ serviceAccountKey.json not found and no environment variable set');
    console.error('Please set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT environment variable');
    process.exit(1);
  }
}

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

    // Validate token format
    if (typeof token !== 'string' || token.length < 100) {
      return res.status(400).json({
        error: 'Invalid token format'
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

// Validate tokens before sending
function validateTokens(tokens) {
  const validTokens = [];
  const invalidTokens = [];
  
  tokens.forEach(token => {
    if (typeof token === 'string' && 
        token.length > 100 && 
        token.startsWith('f')) {
      validTokens.push(token);
    } else {
      invalidTokens.push(token);
    }
  });
  
  if (invalidTokens.length > 0) {
    console.log(`⚠️ Invalid tokens found: ${invalidTokens.length}`);
    invalidTokens.forEach(token => {
      console.log(`❌ Invalid token: ${token?.substring(0, 50)}...`);
    });
  }
  
  return validTokens;
}

// Send to unique users - WITH EXPANDABLE NOTIFICATIONS
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

    // Validate tokens before sending
    uniqueTokens = validateTokens(uniqueTokens);

    if (uniqueTokens.length === 0) {
      console.log('⚠️ No valid tokens to send');
      return res.status(200).json({
        success: true,
        successCount: 0,
        failureCount: 0,
        message: 'No valid registered users'
      });
    }

    console.log(`📤 Sending to ${uniqueTokens.length} valid users...`);

    // Prepare message with expandable notifications
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
              errorCode === 'messaging/registration-token-not-registered' ||
              errorCode === 'messaging/invalid-argument') {
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

// Enhanced notification with custom messages
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

    // Validate tokens
    const validTokens = validateTokens(uniqueTokens);

    if (validTokens.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No valid users to notify',
        successCount: 0,
        failureCount: 0
      });
    }

    // Enhanced message content
    const title = isOpen ? 'Shop is Now OPEN!' : 'Shop is Now CLOSED';
    const body = isOpen 
      ? 'Great news! We are now open and ready to serve you with fresh haircuts and styling services. Come visit us for your grooming needs! ✂️'
      : 'Thank you for your visit today! We are now closed and will reopen tomorrow with fresh energy and great service. See you soon! 👋';

    console.log(`📤 Sending shop ${isOpen ? 'OPEN' : 'CLOSED'} to ${validTokens.length} valid users`);

    // Enhanced message
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
      data: {
        type: 'shop_status',
        status: isOpen ? 'open' : 'closed',
        timestamp: new Date().toISOString(),
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
      },
      tokens: validTokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`✅ Shop status sent - Success: ${response.successCount}, Failed: ${response.failureCount}`);

    // Cleanup invalid tokens
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          if (errorCode === 'messaging/invalid-registration-token' ||
              errorCode === 'messaging/registration-token-not-registered' ||
              errorCode === 'messaging/invalid-argument') {
            const tokenToRemove = validTokens[idx];
            const userIdToRemove = userIds[idx];
            
            if (userIdToRemove) {
              userTokens.delete(userIdToRemove);
              db.collection('fcm_tokens').doc(userIdToRemove).delete();
              console.log(`🗑️ Removed invalid token for user: ${userIdToRemove}`);
            }
          }
        }
      });
    }

    res.status(200).json({
      success: true,
      status: isOpen ? 'open' : 'closed',
      successCount: response.successCount,
      failureCount: response.failureCount,
      totalUsers: validTokens.length,
      message: `Shop ${isOpen ? 'opened' : 'closed'} notification sent`
    });

  } catch (error) {
    console.error('❌ Shop status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Auto-close shop at 5PM Philippine Time
async function autoCloseShop() {
  try {
    console.log('🕔 Auto-close: Checking shop status...');
    
    // Get current shop status
    const shopDoc = await db.collection('shop_status').doc('current').get();
    
    if (shopDoc.exists && shopDoc.data().isOpen === true) {
      console.log('🕔 Auto-close: Shop is open, closing now...');
      
      // Update Firestore status to closed
      await db.collection('shop_status').doc('current').set({
        'isOpen': false,
        'updatedAt': admin.firestore.FieldValue.serverTimestamp(),
        'updatedBy': 'auto_system',
        'autoClosed': true,
        'lastAutoClose': new Date().toISOString()
      }, { merge: true });

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

      // Validate tokens
      const validTokens = validateTokens(uniqueTokens);

      if (validTokens.length > 0) {
        // Send auto-close notification (same style as manual close)
        const title = 'Shop is Now CLOSED';
        const body = 'Thank you for your visit today! We are now closed and will reopen tomorrow with fresh energy and great service. See you soon! 👋';

        console.log(`📤 Auto-close: Sending notification to ${validTokens.length} users`);

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
          data: {
            type: 'shop_status',
            status: 'closed',
            auto_closed: 'true',
            timestamp: new Date().toISOString(),
            click_action: 'FLUTTER_NOTIFICATION_CLICK'
          },
          tokens: validTokens
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`✅ Auto-close: Notification sent - Success: ${response.successCount}, Failed: ${response.failureCount}`);
        
        // Log the auto-close event
        await db.collection('auto_close_logs').add({
          timestamp: new Date().toISOString(),
          usersNotified: validTokens.length,
          successCount: response.successCount,
          failureCount: response.failureCount,
          phTime: getPhilippineTime()
        });
        
      } else {
        console.log('⚠️ Auto-close: No valid users to notify');
      }
      
      console.log('✅ Auto-close: Shop successfully closed at 5PM PH Time');
    } else {
      console.log('ℹ️ Auto-close: Shop is already closed, no action needed');
    }
  } catch (error) {
    console.error('❌ Auto-close error:', error);
    
    // Log the error
    await db.collection('auto_close_errors').add({
      timestamp: new Date().toISOString(),
      error: error.message,
      phTime: getPhilippineTime()
    });
  }
}

// Get current Philippine time
function getPhilippineTime() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

// Schedule auto-close at 5PM Philippine Time every day
function scheduleAutoClose() {
  // Cron schedule for 5PM Philippine Time (17:00)
  // Using 0 9 * * * for 5PM PH Time (UTC+8) = 9AM UTC
  const task = cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Scheduled auto-close triggered at 5PM PH Time');
    console.log(`🕔 Current PH Time: ${getPhilippineTime()}`);
    console.log(`🕔 Current UTC Time: ${new Date().toISOString()}`);
    
    await autoCloseShop();
  }, {
    scheduled: true,
    timezone: "Asia/Manila"
  });

  console.log('⏰ Auto-close scheduled: 5PM Philippine Time every day');
  return task;
}

// Manual trigger for testing auto-close
app.post('/trigger-auto-close', async (req, res) => {
  try {
    console.log('🔧 Manual auto-close trigger');
    await autoCloseShop();
    
    res.status(200).json({
      success: true,
      message: 'Auto-close triggered manually',
      phTime: getPhilippineTime()
    });
  } catch (error) {
    console.error('❌ Manual trigger error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get auto-close logs
app.get('/auto-close-logs', async (req, res) => {
  try {
    const snapshot = await db.collection('auto_close_logs')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    
    const logs = [];
    snapshot.forEach(doc => {
      logs.push({ id: doc.id, ...doc.data() });
    });

    res.status(200).json({
      success: true,
      logs: logs,
      total: logs.length
    });
  } catch (error) {
    console.error('❌ Logs error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint to check tokens
app.get('/debug-tokens', async (req, res) => {
  try {
    const snapshot = await db.collection('fcm_tokens').get();
    const tokens = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      tokens.push({
        userId: data.userId,
        token: data.token ? `${data.token.substring(0, 50)}...` : 'MISSING',
        role: data.role,
        isValid: data.token && typeof data.token === 'string' && data.token.length > 100
      });
    });

    res.status(200).json({
      totalTokens: snapshot.size,
      tokens: tokens
    });
  } catch (error) {
    console.error('❌ Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check with auto-close info
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'Server running',
    uniqueUsers: userTokens.size,
    timestamp: new Date().toISOString(),
    philippineTime: getPhilippineTime(),
    port: process.env.PORT,
    features: {
      expandableNotifications: true,
      enhancedMessages: true,
      tokenValidation: true,
      autoClose: true,
      autoCloseTime: '5:00 PM Philippine Time'
    }
  });
});

// Start server - Use Render's port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Notification service ready`);
  console.log(`👥 Unique users: ${userTokens.size}`);
  console.log(`✨ Features: Expandable Notifications, Enhanced Messages, Token Validation`);
  console.log(`⏰ Auto-close: Scheduled for 5PM Philippine Time daily`);
  console.log(`🕔 Current PH Time: ${getPhilippineTime()}`);
  
  // Sync tokens on startup
  syncTokens();
  
  // Start auto-close scheduler
  scheduleAutoClose();
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
    
    // Validate all tokens
    const allTokens = Array.from(userTokens.values()).map(u => u.token);
    const validTokens = validateTokens(allTokens);
    console.log(`🔍 Token validation: ${validTokens.length}/${allTokens.length} valid tokens`);
    
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
