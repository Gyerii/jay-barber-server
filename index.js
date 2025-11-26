const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();

// Enhanced CORS configuration
app.use(cors({
  origin: ['https://your-app-domain.com', 'http://localhost:3000'], // Add your domains
  credentials: true
}));

app.use(express.json({ limit: '10mb' })); // Add payload limit

// Initialize Firebase Admin with enhanced error handling
let serviceAccount;
let firebaseApp;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Production: Use environment variable
    try {
      const envVar = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
      serviceAccount = JSON.parse(envVar);
      console.log('✅ Using Firebase credentials from environment variable');
    } catch (error) {
      console.error('❌ Error parsing Firebase credentials:', error.message);
      process.exit(1);
    }
  } else {
    // Development: Use local file
    try {
      serviceAccount = require('./serviceAccountKey.json');
      console.log('✅ Using Firebase credentials from local file');
    } catch (error) {
      console.error('❌ serviceAccountKey.json not found and no environment variable set');
      console.error('💡 Please set FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
      process.exit(1);
    }
  }

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  console.log('🚀 Firebase Admin initialized successfully');

} catch (error) {
  console.error('💥 Firebase initialization failed:', error.message);
  process.exit(1);
}

const db = admin.firestore();

// Enhanced memory storage with TTL (Time To Live)
const userTokens = new Map(); // userId -> {token, lastUpdated, isValid}

// Auto-cleanup: Remove tokens older than 30 days
setInterval(() => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let cleanedCount = 0;

  for (const [userId, data] of userTokens.entries()) {
    if (new Date(data.lastUpdated) < thirtyDaysAgo) {
      userTokens.delete(userId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`🧹 Auto-cleaned ${cleanedCount} old tokens`);
  }
}, 24 * 60 * 60 * 1000); // Run daily

console.log('🔄 Token auto-cleanup scheduled');

// Enhanced store token with validation
app.post('/store-token', async (req, res) => {
  try {
    const { token, userId, role, deviceInfo } = req.body;

    // Enhanced validation
    if (!token || !userId) {
      return res.status(400).json({ 
        success: false,
        error: 'Token and userId are required',
        received: { token: !!token, userId: !!userId }
      });
    }

    if (typeof token !== 'string' || token.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token format'
      });
    }

    // Store in memory - ONE token per user
    userTokens.set(userId, {
      token: token.trim(),
      userId: userId.trim(),
      role: (role || 'user').toLowerCase(),
      deviceInfo: deviceInfo || {},
      lastUpdated: new Date().toISOString(),
      isValid: true
    });

    // Store in Firestore with enhanced data
    await db.collection('fcm_tokens').doc(userId).set({
      token: token.trim(),
      userId: userId.trim(),
      role: (role || 'user').toLowerCase(),
      platform: deviceInfo?.platform || 'unknown',
      userAgent: deviceInfo?.userAgent || 'unknown',
      lastActive: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      isValid: true
    }, { merge: true });

    console.log(`✅ Token stored for: ${userId} (${role || 'user'})`);
    console.log(`📊 Total unique users: ${userTokens.size}`);

    res.status(200).json({ 
      success: true,
      message: 'Token stored successfully',
      userId: userId.trim(),
      uniqueUsers: userTokens.size,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Store token error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// Enhanced remove token
app.post('/remove-token', async (req, res) => {
  try {
    const { token, userId } = req.body;

    let removedCount = 0;

    if (userId) {
      if (userTokens.has(userId)) {
        userTokens.delete(userId);
        removedCount++;
      }
      await db.collection('fcm_tokens').doc(userId).delete();
      console.log(`🗑️ Removed by userId: ${userId}`);
    } 
    
    if (token && !userId) {
      // Find by token
      for (const [key, value] of userTokens.entries()) {
        if (value.token === token) {
          userTokens.delete(key);
          await db.collection('fcm_tokens').doc(key).delete();
          removedCount++;
          console.log(`🗑️ Removed by token: ${key}`);
          break;
        }
      }
    }

    console.log(`📊 Remaining users: ${userTokens.size}, Removed: ${removedCount}`);

    res.status(200).json({ 
      success: true,
      message: 'Token removed successfully',
      removedCount,
      remainingUsers: userTokens.size
    });

  } catch (error) {
    console.error('❌ Remove token error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error'
    });
  }
});

// Enhanced token count with more stats
app.get('/token-count', async (req, res) => {
  try {
    // Sync with Firestore
    const snapshot = await db.collection('fcm_tokens').get();
    
    userTokens.clear();
    let validTokens = 0;

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.userId && data.token && data.isValid !== false) {
        userTokens.set(data.userId, {
          token: data.token,
          userId: data.userId,
          role: data.role || 'user',
          deviceInfo: {},
          lastUpdated: data.updatedAt,
          isValid: true
        });
        validTokens++;
      }
    });

    const uniqueUsers = userTokens.size;

    console.log(`📊 Stats - Unique users: ${uniqueUsers}, Valid tokens: ${validTokens}, Total docs: ${snapshot.size}`);

    res.status(200).json({ 
      success: true,
      activeTokens: uniqueUsers,
      uniqueUsers: uniqueUsers,
      totalDevices: snapshot.size,
      validTokens: validTokens,
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Token count error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error'
    });
  }
});

// Enhanced send to unique users with clickable notifications
app.post('/send-to-unique-users', async (req, res) => {
  try {
    const { title, body, tokens, userIds, data } = req.body;

    // Enhanced validation
    if (!title || !body) {
      return res.status(400).json({ 
        success: false,
        error: 'Title and body are required'
      });
    }

    let uniqueTokens = [];
    let targetUserIds = [];

    if (tokens && Array.isArray(tokens) && tokens.length > 0) {
      // Use provided tokens (remove duplicates)
      uniqueTokens = [...new Set(tokens.filter(token => typeof token === 'string' && token.length > 10))];
      targetUserIds = userIds || [];
    } else {
      // Get from Firestore - only valid tokens
      const snapshot = await db.collection('fcm_tokens')
        .where('isValid', '==', true)
        .get();
      
      const tokenSet = new Set();
      const userIdSet = new Set();

      snapshot.forEach(doc => {
        const docData = doc.data();
        if (docData.token && docData.userId) {
          tokenSet.add(docData.token);
          userIdSet.add(docData.userId);
        }
      });

      uniqueTokens = Array.from(tokenSet);
      targetUserIds = Array.from(userIdSet);
    }

    if (uniqueTokens.length === 0) {
      console.log('⚠️ No valid tokens available for sending');
      return res.status(200).json({
        success: true,
        successCount: 0,
        failureCount: 0,
        uniqueUsers: 0,
        message: 'No registered users with valid tokens'
      });
    }

    console.log(`📤 Sending to ${uniqueTokens.length} unique users: "${title}"`);

    // Enhanced message with clickable data
    const message = {
      notification: { 
        title: title,
        body: body
      },
      data: {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        screen: 'shop_status',
        status: data?.status || 'unknown',
        timestamp: new Date().toISOString(),
        type: 'shop_status_update',
        ...data // Allow custom data
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          priority: 'max',
          tag: 'shop_status',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          icon: 'ic_launcher'
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

    // Send with timeout
    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`✅ Notification sent - Success: ${response.successCount}, Failed: ${response.failureCount}`);

    // Enhanced invalid token cleanup
    if (response.failureCount > 0) {
      const invalidTokens = [];
      
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          const token = uniqueTokens[idx];
          
          console.log(`❌ Token failed: ${errorCode} - ${token.substring(0, 20)}...`);
          
          if (errorCode === 'messaging/invalid-registration-token' ||
              errorCode === 'messaging/registration-token-not-registered') {
            invalidTokens.push(token);
          }
        }
      });

      // Clean up invalid tokens
      if (invalidTokens.length > 0) {
        await cleanupInvalidTokens(invalidTokens, targetUserIds);
      }
    }

    res.status(200).json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      uniqueUsers: uniqueTokens.length,
      message: `Notification sent to ${response.successCount} users`
    });

  } catch (error) {
    console.error('❌ Send notification error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to send notifications',
      details: error.message 
    });
  }
});

// Helper function to clean invalid tokens
async function cleanupInvalidTokens(invalidTokens, userIds) {
  try {
    let cleanedCount = 0;

    for (const token of invalidTokens) {
      // Find userId for this token
      let userIdToRemove = null;
      
      for (const [userId, data] of userTokens.entries()) {
        if (data.token === token) {
          userIdToRemove = userId;
          break;
        }
      }

      // If userId found, remove from both memory and Firestore
      if (userIdToRemove) {
        userTokens.delete(userIdToRemove);
        await db.collection('fcm_tokens').doc(userIdToRemove).delete();
        cleanedCount++;
        console.log(`🗑️ Cleaned invalid token for user: ${userIdToRemove}`);
      }
    }

    console.log(`🧹 Cleaned ${cleanedCount} invalid tokens`);
    
  } catch (error) {
    console.error('❌ Cleanup error:', error);
  }
}

// Legacy endpoint with enhanced logging
app.post('/send-to-all', async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({ 
        success: false,
        error: 'Title and body are required'
      });
    }

    console.log(`🔄 Legacy endpoint called: "${title}"`);

    // Forward to enhanced endpoint
    const enhancedResponse = await admin.messaging().sendEachForMulticast({
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          tag: 'shop_status'
        }
      },
      tokens: Array.from(userTokens.values()).map(user => user.token)
    });

    console.log(`✅ Legacy: Sent to ${enhancedResponse.successCount} users`);

    res.status(200).json({
      success: true,
      successCount: enhancedResponse.successCount,
      failureCount: enhancedResponse.failureCount,
      totalDevices: userTokens.size,
      message: 'Notification sent via legacy endpoint'
    });

  } catch (error) {
    console.error('❌ Legacy endpoint error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Enhanced health check with more details
app.get('/health', (req, res) => {
  const healthInfo = {
    status: '🟢 Server is healthy',
    timestamp: new Date().toISOString(),
    uptime: `${process.uptime().toFixed(2)} seconds`,
    memory: {
      used: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
      total: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB`
    },
    stats: {
      uniqueUsers: userTokens.size,
      serverStartTime: new Date(Date.now() - process.uptime() * 1000).toISOString()
    }
  };

  res.status(200).json(healthInfo);
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({ 
    service: 'JayBarber Notification Server',
    status: '🚀 Operational',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'POST /store-token',
      'POST /remove-token',
      'GET /token-count',
      'POST /send-to-unique-users',
      'POST /send-to-all',
      'GET /health'
    ]
  });
});

// Enhanced 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl,
    availableEndpoints: [
      'GET /',
      'GET /health',
      'POST /store-token',
      'POST /remove-token',
      'GET /token-count',
      'POST /send-to-unique-users',
      'POST /send-to-all'
    ]
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('💥 Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message
  });
});

// Start server with enhanced logging
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Notification service ready`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Sync tokens on startup
  syncTokens();
});

// Enhanced sync function
async function syncTokens() {
  try {
    const snapshot = await db.collection('fcm_tokens').get();
    
    const previousCount = userTokens.size;
    userTokens.clear();

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.userId && data.token && data.isValid !== false) {
        userTokens.set(data.userId, {
          token: data.token,
          userId: data.userId,
          role: data.role || 'user',
          deviceInfo: {},
          lastUpdated: data.updatedAt,
          isValid: true
        });
      }
    });
    
    console.log(`✅ Sync complete: ${userTokens.size} users (was ${previousCount})`);
    
  } catch (error) {
    console.error('❌ Sync error:', error);
  }
}

// Enhanced graceful shutdown
process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM received: Shutting down gracefully...');
  console.log(`💾 Final stats: ${userTokens.size} users in memory`);
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('👋 SIGINT received: Shutting down gracefully...');
  console.log(`💾 Final stats: ${userTokens.size} users in memory`);
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
