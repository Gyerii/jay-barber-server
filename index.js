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
const userTokens = new Map(); // userId -> {token,userId,role,deviceInfo,lastUpdated}

console.log('🚀 Firebase Admin initialized');

// =========================
// ✅ HELPERS
// =========================
function validateTokens(tokens) {
  const validTokens = [];
  const invalidTokens = [];

  tokens.forEach(token => {
    if (typeof token === 'string' && token.length > 100) {
      validTokens.push(token);
    } else {
      invalidTokens.push(token);
    }
  });

  if (invalidTokens.length > 0) {
    console.log(`⚠️ Invalid tokens found: ${invalidTokens.length}`);
  }

  console.log(`🔍 validateTokens: ${validTokens.length}/${tokens.length} valid`);
  return validTokens;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

// Get current hour in Philippine Time
function getCurrentPhilippineHour() {
  const now = new Date();
  const phTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
  return phTime.getHours();
}

// ✅ Get role of user by uid from /users/{uid}
async function getUserRoleById(userId) {
  try {
    if (!userId) return 'user';
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return 'user';
    return (doc.data()?.role || 'user').toString();
  } catch (e) {
    console.log('⚠️ getUserRoleById failed:', e.message);
    return 'user';
  }
}

// ✅ Role-based filtering rule (YOUR REQUEST):
// - always skip senderId
// - if senderRole is admin => skip all admin recipients
// - if senderRole is super_admin => skip all super_admin recipients
function shouldSkipRecipient({ senderId, senderRole, recipientUserId, recipientRole }) {
  if (!recipientUserId) return true;

  // Always skip sender
  if (senderId && recipientUserId === senderId) return true;

  // Staff group suppression:
  if (senderRole === 'admin' && recipientRole === 'admin') return true;
  if (senderRole === 'super_admin' && recipientRole === 'super_admin') return true;

  return false;
}

// ✅ Cleanup invalid tokens by token string
async function cleanupInvalidTokensByList(tokensList) {
  for (const token of tokensList) {
    const badDocs = await db.collection('fcm_tokens').where('token', '==', token).get();
    for (const d of badDocs.docs) {
      userTokens.delete(d.id);
      await db.collection('fcm_tokens').doc(d.id).delete();
      console.log(`🗑️ Cleaned invalid token doc: ${d.id}`);
    }
  }
}

// ✅ IMPORTANT: Transaction lock to prevent duplicate notification
async function claimNotificationLock(docRef) {
  try {
    const claimed = await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      if (!snap.exists) return false;

      const data = snap.data() || {};
      if (data.notified === true) return false;

      // claim lock
      t.set(docRef, {
        notified: true,
        notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        notifiedByInstance: process.env.INSTANCE_ID || process.env.RENDER_INSTANCE_ID || 'render'
      }, { merge: true });

      return true;
    });

    return claimed === true;
  } catch (e) {
    console.error('❌ claimNotificationLock error:', e);
    return false;
  }
}

// =========================
// ✅ TOKEN STORE - ONE per user
// =========================
app.post('/store-token', async (req, res) => {
  try {
    const { token, userId, role, deviceInfo } = req.body;

    if (!token || !userId) {
      return res.status(400).json({ error: 'Token and userId required' });
    }

    if (typeof token !== 'string' || token.length < 100) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    userTokens.set(userId, {
      token,
      userId,
      role: role || 'user',
      deviceInfo: deviceInfo || {},
      lastUpdated: new Date().toISOString()
    });

    await db.collection('fcm_tokens').doc(userId).set({
      token,
      userId,
      role: role || 'user',
      platform: deviceInfo?.platform || 'unknown',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`✅ Token stored for: ${userId} (${role || 'user'})`);
    console.log(`📊 Total unique users (memory): ${userTokens.size}`);

    res.status(200).json({ success: true, userId, uniqueUsers: userTokens.size });

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
      for (let [key, value] of userTokens.entries()) {
        if (value.token === token) {
          userTokens.delete(key);
          await db.collection('fcm_tokens').doc(key).delete();
          console.log(`🗑️ Removed by token: ${key}`);
          break;
        }
      }
    }

    console.log(`📊 Remaining users (memory): ${userTokens.size}`);
    res.status(200).json({ success: true, remainingUsers: userTokens.size });

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
    console.log(`📊 Unique users (Firestore): ${uniqueUsers}`);

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

// =========================
// ✅ SEND TO UNIQUE USERS
// =========================
app.post('/send-to-unique-users', async (req, res) => {
  try {
    const { title, body, tokens } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body required' });
    }

    let uniqueTokens = [];

    if (tokens && Array.isArray(tokens)) {
      uniqueTokens = [...new Set(tokens)];
    } else {
      const snapshot = await db.collection('fcm_tokens').get();
      const tokenSet = new Set();
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.token) tokenSet.add(data.token);
      });
      uniqueTokens = Array.from(tokenSet);
    }

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

    const message = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          priority: 'max',
          tag: 'shop_status',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          icon: 'logo'
        }
      },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      data: {
        type: 'general_notification',
        timestamp: new Date().toISOString(),
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
      },
      tokens: uniqueTokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`✅ Success: ${response.successCount}`);
    console.log(`❌ Failed: ${response.failureCount}`);

    if (response.failureCount > 0) {
      const tokensToRemove = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-argument'
          ) {
            tokensToRemove.push(uniqueTokens[idx]);
          }
        }
      });
      await cleanupInvalidTokensByList(tokensToRemove);
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

// =========================
// ✅ SHOP STATUS NOTIFICATION
// =========================
app.post('/send-shop-status', async (req, res) => {
  try {
    const { isOpen } = req.body;

    if (typeof isOpen !== 'boolean') {
      return res.status(400).json({ error: 'isOpen boolean required' });
    }

    const snapshot = await db.collection('fcm_tokens').get();
    const tokens = [];
    const userIds = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.token && data.userId) {
        tokens.push(data.token);
        userIds.push(data.userId);
      }
    });

    const validTokens = validateTokens(tokens);

    if (validTokens.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No valid users to notify',
        successCount: 0,
        failureCount: 0
      });
    }

    const title = isOpen ? 'Shop is Now OPEN!' : 'Shop is Now CLOSED';
    const body = isOpen
      ? 'Great news! We are now open and ready to serve you with fresh haircuts and styling services. Come visit us for your grooming needs! ✂️'
      : 'Thank you for your visit today! We are now closed and will reopen tomorrow with fresh energy and great service. See you soon! 👋';

    console.log(`📤 Sending shop ${isOpen ? 'OPEN' : 'CLOSED'} to ${validTokens.length} valid users`);

    const message = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          priority: 'max',
          tag: 'shop_status',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          icon: 'logo'
        }
      },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      data: {
        type: 'shop_status',
        status: isOpen ? 'open' : 'closed',
        timestamp: new Date().toISOString(),
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        icon: 'logo'
      },
      tokens: validTokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`✅ Shop status sent - Success: ${response.successCount}, Failed: ${response.failureCount}`);

    if (response.failureCount > 0) {
      const badTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-argument'
          ) {
            badTokens.push(validTokens[idx]);
            const userIdToRemove = userIds[idx];
            if (userIdToRemove) {
              userTokens.delete(userIdToRemove);
              db.collection('fcm_tokens').doc(userIdToRemove).delete();
              console.log(`🗑️ Removed invalid token for user: ${userIdToRemove}`);
            }
          }
        }
      });

      if (badTokens.length > 0) {
        await cleanupInvalidTokensByList(badTokens);
      }
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

// =========================
// ✅ GROUP CHAT NOTIFICATION (ROLE FILTERED + NO DUPLICATES)
// =========================
async function sendGroupChatNotificationRoleFiltered({ chatDocId, senderId, senderName, messageType, message }) {
  const senderRole = await getUserRoleById(senderId);

  const snap = await db.collection('fcm_tokens').get();
  const tokens = [];

  snap.forEach(doc => {
    const data = doc.data() || {};
    const recipientUserId = (data.userId || doc.id || '').toString();
    const recipientRole = (data.role || 'user').toString();
    const token = data.token;

    if (!token || typeof token !== 'string') return;

    if (shouldSkipRecipient({
      senderId,
      senderRole,
      recipientUserId,
      recipientRole
    })) return;

    tokens.push(token);
  });

  const validTokens = validateTokens(tokens);
  if (validTokens.length === 0) {
    console.log('⚠️ No valid recipients after role filtering (group chat).');
    return { successCount: 0, failureCount: 0 };
  }

  const title = (senderName && senderName.trim()) ? senderName.trim() : 'New message';

  let body = (message || '').trim();
  if (messageType === 'image') body = '📷 sent a photo';
  if (messageType === 'video') body = '🎥 sent a video';
  if (!body) body = 'sent a message';

  const chunks = chunkArray(validTokens, 500);

  let totalSuccess = 0;
  let totalFailure = 0;

  for (const chunk of chunks) {
    const payload = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'group_chat_channel',
          sound: 'default',
          priority: 'max',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          icon: 'logo',
          // ✅ tag helps Android merge duplicates if ever re-sent
          tag: chatDocId ? `group_chat_${chatDocId}` : 'group_chat'
        }
      },
      apns: { payload: { aps: { sound: 'default' } } },
      data: {
        type: 'group_chat',
        chatDocId: (chatDocId || '').toString(), // ✅ Stable dedup key for Flutter
        senderId: (senderId || '').toString(),
        senderName: (senderName || '').toString(),
        senderRole: senderRole,
        messageType: (messageType || 'text').toString(),
        message: (message || '').toString(),
        timestamp: new Date().toISOString(),
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
      },
      tokens: chunk
    };

    const resp = await admin.messaging().sendEachForMulticast(payload);
    totalSuccess += resp.successCount;
    totalFailure += resp.failureCount;

    if (resp.failureCount > 0) {
      const toRemove = [];
      for (let i = 0; i < resp.responses.length; i++) {
        const r = resp.responses[i];
        if (!r.success) {
          const code = r.error?.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-argument'
          ) {
            toRemove.push(chunk[i]);
          }
        }
      }
      if (toRemove.length > 0) await cleanupInvalidTokensByList(toRemove);
    }
  }

  console.log(`✅ Group chat notif done. Success=${totalSuccess}, Failed=${totalFailure}`);
  return { successCount: totalSuccess, failureCount: totalFailure };
}

function listenGroupChatNotifications() {
  console.log('👂 Listening to Firestore group_chat for new messages...');

  let firstSnapshot = true;

  db.collection('group_chat')
    .orderBy('timestamp', 'desc')
    .limit(25)
    .onSnapshot(async (snapshot) => {
      try {
        if (firstSnapshot) {
          firstSnapshot = false;
          console.log('👂 Listener ready (initial snapshot ignored)');
          return;
        }

        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added') continue;

          const doc = change.doc;
          const data = doc.data() || {};

          // ✅ IMPORTANT: Lock/claim here (prevents duplicates across Render instances)
          const claimed = await claimNotificationLock(doc.ref);
          if (!claimed) {
            // Another server already handled it
            continue;
          }

          const messageType = (data.messageType || 'text').toString();

          // ignore system messages (but already locked notified=true)
          if (messageType === 'system' || messageType === 'group_update') {
            continue;
          }

          await sendGroupChatNotificationRoleFiltered({
            chatDocId: doc.id,
            senderId: (data.senderId || '').toString(),
            senderName: (data.senderName || 'Someone').toString(),
            messageType,
            message: (data.message || '').toString()
          });
        }
      } catch (e) {
        console.error('❌ group_chat listener error:', e);
      }
    }, (err) => {
      console.error('❌ Firestore listen failed:', err);
    });
}

// =========================
// AUTO-CLOSE SHOP (your full logic)
// =========================
async function autoCloseShop() {
  try {
    const currentHour = getCurrentPhilippineHour();
    console.log(`🕔 Auto-close: Checking shop status at ${getPhilippineTime()} (Hour: ${currentHour})...`);

    const shopDoc = await db.collection('shop_status').doc('current').get();

    if (shopDoc.exists && shopDoc.data().isOpen === true) {
      console.log('🕔 Auto-close: Shop is open, closing now...');

      await db.collection('shop_status').doc('current').set({
        isOpen: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: 'auto_system',
        autoClosed: true,
        lastAutoClose: new Date().toISOString()
      }, { merge: true });

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

      const validTokens = validateTokens(uniqueTokens);

      if (validTokens.length > 0) {
        const title = 'Shop is Now CLOSED';
        const body = 'Thank you for your visit today! We are now closed and will reopen tomorrow with fresh energy and great service. See you soon! 👋';

        console.log(`📤 Auto-close: Sending notification to ${validTokens.length} users`);

        const message = {
          notification: { title, body },
          android: {
            priority: 'high',
            notification: {
              channelId: 'shop_status_channel',
              sound: 'default',
              priority: 'max',
              tag: 'shop_status',
              clickAction: 'FLUTTER_NOTIFICATION_CLICK',
              icon: 'logo'
            }
          },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
          data: {
            type: 'shop_status',
            status: 'closed',
            auto_closed: 'true',
            timestamp: new Date().toISOString(),
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
            icon: 'logo'
          },
          tokens: validTokens
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`✅ Auto-close: Notification sent - Success: ${response.successCount}, Failed: ${response.failureCount}`);

        await db.collection('auto_close_logs').add({
          timestamp: new Date().toISOString(),
          usersNotified: validTokens.length,
          successCount: response.successCount,
          failureCount: response.failureCount,
          phTime: getPhilippineTime(),
          phHour: currentHour,
          action: 'auto_closed'
        });

      } else {
        console.log('⚠️ Auto-close: No valid users to notify');

        await db.collection('auto_close_logs').add({
          timestamp: new Date().toISOString(),
          usersNotified: 0,
          successCount: 0,
          failureCount: 0,
          phTime: getPhilippineTime(),
          phHour: currentHour,
          action: 'auto_closed_no_users'
        });
      }

      console.log('✅ Auto-close: Shop successfully closed at 5PM PH Time');
    } else {
      console.log('ℹ️ Auto-close: Shop is already closed, no action needed');

      await db.collection('auto_close_logs').add({
        timestamp: new Date().toISOString(),
        usersNotified: 0,
        successCount: 0,
        failureCount: 0,
        phTime: getPhilippineTime(),
        phHour: currentHour,
        action: 'already_closed',
        message: 'Shop was already closed at 5PM'
      });
    }
  } catch (error) {
    console.error('❌ Auto-close error:', error);

    await db.collection('auto_close_errors').add({
      timestamp: new Date().toISOString(),
      error: error.message,
      phTime: getPhilippineTime(),
      stack: error.stack
    });
  }
}

function scheduleAutoClose() {
  console.log('⏰ ENHANCED Auto-close scheduled: 5PM Philippine Time every day (17:00 Asia/Manila)');

  cron.schedule('0 17 * * *', async () => {
    console.log('⏰ 🎯 MAIN: Exact 5:00 PM auto-close triggered');
    console.log(`🕔 Current PH Time: ${getPhilippineTime()}`);
    console.log(`🕔 Current PH Hour: ${getCurrentPhilippineHour()}`);
    await autoCloseShop();
  }, { scheduled: true, timezone: 'Asia/Manila' });

  cron.schedule('2 17 * * *', async () => {
    console.log('⏰ 🛡️ SAFETY: 5:02 PM safety check triggered');
    const shopDoc = await db.collection('shop_status').doc('current').get();
    if (shopDoc.exists && shopDoc.data().isOpen === true) {
      console.log('⏰ 🛡️ SAFETY: Shop still open at 5:02 PM, closing now...');
      await autoCloseShop();
    } else {
      console.log('⏰ 🛡️ SAFETY: Shop already closed at 5:02 PM');
    }
  }, { scheduled: true, timezone: 'Asia/Manila' });
}

// Manual trigger
app.post('/trigger-auto-close', async (req, res) => {
  try {
    console.log('🔧 Manual auto-close trigger');
    console.log(`🕔 Current PH Time: ${getPhilippineTime()}`);
    await autoCloseShop();

    res.status(200).json({
      success: true,
      message: 'Auto-close triggered manually',
      phTime: getPhilippineTime(),
      phHour: getCurrentPhilippineHour()
    });
  } catch (error) {
    console.error('❌ Manual trigger error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'Server running',
    uniqueUsers: userTokens.size,
    timestamp: new Date().toISOString(),
    philippineTime: getPhilippineTime(),
    philippineHour: getCurrentPhilippineHour(),
    port: process.env.PORT,
    features: {
      groupChatNotifications: true,
      roleBasedGroupChatFiltering: true,
      noDuplicateNotifications: true,
      tokenValidation: true,
      autoClose: true,
      autoCloseTime: '5:00 PM Philippine Time Daily (17:00 Asia/Manila)'
    }
  });
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('📱 Notification service ready');
  console.log(`👥 Unique users (memory): ${userTokens.size}`);
  console.log('⏰ Auto-close: Scheduled for 5PM Philippine Time daily (17:00 Asia/Manila)');
  console.log(`🕔 Current PH Time: ${getPhilippineTime()}`);
  console.log(`🌍 Timezone: Asia/Manila (UTC+8)`);

  await syncTokens();
  scheduleAutoClose();

  // ✅ START GROUP CHAT LISTENER
  listenGroupChatNotifications();
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
