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

// ✅ NEW: always dedupe tokens BEFORE validate + send
function dedupeTokens(tokens) {
  return Array.from(new Set((tokens || []).filter(Boolean)));
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

// ✅ NEW: Get display name of user by uid from /users/{uid}
async function getUserDisplayNameById(userId) {
  try {
    if (!userId) return 'Unknown user';
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) return 'Unknown user';

    const d = doc.data() || {};
    const fullName = (d.fullName || d.name || d.displayName || '').toString().trim();
    if (fullName) return fullName;

    const first = (d.firstName || '').toString().trim();
    const last = (d.lastName || '').toString().trim();
    const combined = `${first} ${last}`.trim();
    if (combined) return combined;

    const phone = (d.phone || d.phoneNumber || '').toString().trim();
    if (phone) return phone;

    return 'Unknown user';
  } catch (e) {
    console.log('⚠️ getUserDisplayNameById failed:', e.message);
    return 'Unknown user';
  }
}

// ✅ Role-based filtering rule
function shouldSkipRecipient({ senderId, senderRole, recipientUserId, recipientRole }) {
  if (!recipientUserId) return true;

  if (senderId && recipientUserId === senderId) return true;

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

// ✅ IMPORTANT: Transaction lock to prevent duplicate notification (group chat)
async function claimNotificationLock(docRef) {
  try {
    const claimed = await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      if (!snap.exists) return false;

      const data = snap.data() || {};
      if (data.notified === true) return false;

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
// ✅ BOOKING STATUS NOTIFICATION LOCK (no duplicates across instances)
// =========================
async function claimBookingStatusLock(bookingRef, status) {
  try {
    const claimed = await db.runTransaction(async (t) => {
      const snap = await t.get(bookingRef);
      if (!snap.exists) return false;

      const data = snap.data() || {};
      const already = (data.bookingNotifiedStatus || '').toString();

      if (already === status) return false;

      t.set(bookingRef, {
        bookingNotifiedStatus: status,
        bookingNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        bookingNotifiedByInstance: process.env.INSTANCE_ID || process.env.RENDER_INSTANCE_ID || 'render'
      }, { merge: true });

      return true;
    });

    return claimed === true;
  } catch (e) {
    console.error('❌ claimBookingStatusLock error:', e);
    return false;
  }
}

// =========================
// ✅ NEW: BOOKING REQUEST NOTIFICATION LOCK (notify admin once)
// =========================
async function claimBookingRequestLock(bookingRef) {
  try {
    const claimed = await db.runTransaction(async (t) => {
      const snap = await t.get(bookingRef);
      if (!snap.exists) return false;

      const data = snap.data() || {};
      if (data.adminNotifiedNewBooking === true) return false;

      t.set(bookingRef, {
        adminNotifiedNewBooking: true,
        adminNotifiedNewBookingAt: admin.firestore.FieldValue.serverTimestamp(),
        adminNotifiedNewBookingByInstance: process.env.INSTANCE_ID || process.env.RENDER_INSTANCE_ID || 'render'
      }, { merge: true });

      return true;
    });

    return claimed === true;
  } catch (e) {
    console.error('❌ claimBookingRequestLock error:', e);
    return false;
  }
}

// =========================
// ✅ Send BOOKING notification ONLY to booking owner
// =========================
async function sendBookingStatusToOwner({ bookingId, userId, status, bookingData }) {
  try {
    if (!userId || !status || !bookingId) return;

    if (status === 'pending') return;

    const tokenDoc = await db.collection('fcm_tokens').doc(userId).get();
    if (!tokenDoc.exists) {
      console.log(`⚠️ No token found for booking owner: ${userId}`);
      return;
    }

    const token = (tokenDoc.data()?.token || '').toString();
    if (!token || token.length < 100) {
      console.log(`⚠️ Invalid token for booking owner: ${userId}`);
      return;
    }

    const haircutName = (bookingData?.haircutName || 'Booking').toString();
    const slot = (bookingData?.slot || '').toString();

    let title = 'Booking Update';
    let body = `${haircutName} status updated: ${status}`;

    if (status === 'approved' || status === 'confirmed') {
      title = 'Booking Approved';
      body = slot ? `Your booking is approved for ${slot}.` : 'Your booking is approved.';
    } else if (status === 'declined') {
      title = 'Booking Declined';
      body = 'Sorry, your booking was declined. You can book another schedule.';
    } else if (status === 'cancelled') {
      title = 'Booking Cancelled';
      body = 'Your booking was cancelled.';
    } else if (status === 'completed') {
      title = 'Booking Completed';
      body = 'Your booking is completed. Thank you!';
    } else if (status === 'passed') {
      title = 'Booking Passed';
      body = 'Your booking schedule has passed.';
    }

    const dedupeKey = `booking_${bookingId}_${status}`;

    const payload = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'booking_channel',
          sound: 'default',
          priority: 'max',
          icon: 'logo',
          tag: dedupeKey,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        }
      },
      apns: { payload: { aps: { sound: 'default' } } },
      data: {
        type: 'booking_status',
        dedupeKey,
        bookingId: bookingId.toString(),
        userId: userId.toString(),
        status: status.toString(),
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        timestamp: new Date().toISOString()
      },
      token
    };

    const resp = await admin.messaging().send(payload);
    console.log(`✅ Booking status notif sent to owner ${userId}: ${status} (msgId=${resp})`);
  } catch (e) {
    console.error('❌ sendBookingStatusToOwner error:', e);
  }
}

// =========================
// ✅ NEW: helpers for admin booking request format (BOLD NAME + DATE ONLY)
// =========================
function toBoldUnicode(text) {
  const str = (text || '').toString();
  const map = {
    'A':'𝗔','B':'𝗕','C':'𝗖','D':'𝗗','E':'𝗘','F':'𝗙','G':'𝗚','H':'𝗛','I':'𝗜','J':'𝗝','K':'𝗞','L':'𝗟','M':'𝗠','N':'𝗡','O':'𝗢','P':'𝗣','Q':'𝗤','R':'𝗥','S':'𝗦','T':'𝗧','U':'𝗨','V':'𝗩','W':'𝗪','X':'𝗫','Y':'𝗬','Z':'𝗭',
    'a':'𝗮','b':'𝗯','c':'𝗰','d':'𝗱','e':'𝗲','f':'𝗳','g':'𝗴','h':'𝗵','i':'𝗶','j':'𝗷','k':'𝗸','l':'𝗹','m':'𝗺','n':'𝗻','o':'𝗼','p':'𝗽','q':'𝗾','r':'𝗿','s':'𝘀','t':'𝘁','u':'𝘂','v':'𝘃','w':'𝘄','x':'𝘅','y':'𝘆','z':'𝘇',
    '0':'𝟬','1':'𝟭','2':'𝟮','3':'𝟯','4':'𝟰','5':'𝟱','6':'𝟲','7':'𝟳','8':'𝟴','9':'𝟵'
  };
  return str.split('').map(ch => map[ch] || ch).join('');
}

function formatBookingDate(dateVal) {
  try {
    let d = null;

    if (dateVal && typeof dateVal === 'object' && typeof dateVal.toDate === 'function') {
      d = dateVal.toDate();
    } else if (dateVal instanceof Date) {
      d = dateVal;
    } else if (typeof dateVal === 'string') {
      const s = dateVal.trim();

      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
        const parts = s.split('/');
        const mm = String(parseInt(parts[0], 10)).padStart(2, '0');
        const dd = String(parseInt(parts[1], 10)).padStart(2, '0');
        const yyyy = String(parts[2]);
        return `${mm}/${dd}/${yyyy}`;
      }

      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [yyyy, mm, dd] = s.split('-');
        return `${mm}/${dd}/${yyyy}`;
      }

      const parsed = new Date(s);
      if (!isNaN(parsed.getTime())) d = parsed;
    }

    if (!d) return '';

    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${mm}/${dd}/${yyyy}`;
  } catch (_) {
    return '';
  }
}

// =========================
// ✅ Send NEW BOOKING REQUEST notification to ALL ADMIN + SUPER_ADMIN
// ✅ FIXED: token dedupe to prevent duplicates
// =========================
async function sendNewBookingRequestToAdmins({ bookingId, bookingData }) {
  try {
    const userId = (bookingData?.userId || '').toString();
    const userName = await getUserDisplayNameById(userId);

    const haircutName = (bookingData?.haircutName || bookingData?.serviceName || 'Booking').toString().trim();

    const dateVal = bookingData?.date || bookingData?.day || bookingData?.bookingDate;
    const formattedDate = formatBookingDate(dateVal) || 'Unknown date';

    const title = 'New Booking Request';
    const body = `${toBoldUnicode(userName)} • ${haircutName} • ${formattedDate}`;

    const snap = await db.collection('fcm_tokens').get();
    const tokens = [];

    snap.forEach(doc => {
      const d = doc.data() || {};
      const role = (d.role || 'user').toString();
      const token = (d.token || '').toString();
      if (!token || token.length < 100) return;
      if (role === 'admin' || role === 'super_admin') tokens.push(token);
    });

    const uniqueTokens = dedupeTokens(tokens);
    const validTokens = validateTokens(uniqueTokens);

    if (validTokens.length === 0) {
      console.log('⚠️ No admin tokens found for new booking request');
      return { successCount: 0, failureCount: 0 };
    }

    const chunks = chunkArray(validTokens, 500);

    let totalSuccess = 0;
    let totalFailure = 0;

    const dedupeKey = `booking_request_${bookingId}`;

    for (const chunk of chunks) {
      const payload = {
        notification: { title, body },
        android: {
          priority: 'high',
          notification: {
            channelId: 'booking_channel',
            sound: 'default',
            priority: 'max',
            icon: 'logo',
            tag: dedupeKey,
            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          }
        },
        apns: { payload: { aps: { sound: 'default' } } },
        data: {
          type: 'booking_request',
          dedupeKey,
          bookingId: (bookingId || '').toString(),
          userId: (userId || '').toString(),
          userName: (userName || '').toString(),
          haircutName: (haircutName || '').toString(),
          date: (formattedDate || '').toString(),
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          timestamp: new Date().toISOString()
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

    console.log(`✅ New booking request notif sent to admins. Success=${totalSuccess}, Failed=${totalFailure}`);
    return { successCount: totalSuccess, failureCount: totalFailure };
  } catch (e) {
    console.error('❌ sendNewBookingRequestToAdmins error:', e);
    return { successCount: 0, failureCount: 0 };
  }
}

// =========================
// ✅ Listen booking status changes and notify ONLY owner
// =========================
function listenBookingStatusNotifications() {
  console.log('👂 Listening to Firestore bookings for status changes...');

  db.collection('bookings')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .onSnapshot(async (snapshot) => {
      try {
        for (const change of snapshot.docChanges()) {
          if (change.type !== 'modified') continue;

          const doc = change.doc;
          const data = doc.data() || {};
          const bookingId = doc.id;

          const userId = (data.userId || '').toString();
          const status = (data.status || 'pending').toString();

          if (!status || status === 'pending') continue;

          const allowed = new Set(['approved', 'confirmed', 'declined', 'cancelled', 'completed', 'passed']);
          if (!allowed.has(status)) continue;

          const claimed = await claimBookingStatusLock(doc.ref, status);
          if (!claimed) continue;

          await sendBookingStatusToOwner({
            bookingId,
            userId,
            status,
            bookingData: data
          });
        }
      } catch (e) {
        console.error('❌ bookings listener error:', e);
      }
    }, (err) => {
      console.error('❌ Firestore bookings listen failed:', err);
    });
}

// =========================
// ✅ Listen NEW bookings and notify ADMINS on "added"
// =========================
function listenNewBookingRequestNotifications() {
  console.log('👂 Listening to Firestore bookings for NEW booking requests (notify admin)...');

  let firstSnapshot = true;

  db.collection('bookings')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .onSnapshot(async (snapshot) => {
      try {
        if (firstSnapshot) {
          firstSnapshot = false;
          console.log('👂 New booking listener ready (initial snapshot ignored)');
          return;
        }

        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added') continue;

          const doc = change.doc;
          const data = doc.data() || {};
          const bookingId = doc.id;

          const status = (data.status || 'pending').toString();
          if (status !== 'pending') continue;

          const claimed = await claimBookingRequestLock(doc.ref);
          if (!claimed) continue;

          await sendNewBookingRequestToAdmins({
            bookingId,
            bookingData: data
          });
        }
      } catch (e) {
        console.error('❌ new booking listener error:', e);
      }
    }, (err) => {
      console.error('❌ Firestore new booking listen failed:', err);
    });
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
// ✅ SEND TO UNIQUE USERS (FIXED DEDUPE)
// =========================
app.post('/send-to-unique-users', async (req, res) => {
  try {
    const { title, body, tokens } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body required' });
    }

    let uniqueTokens = [];

    if (tokens && Array.isArray(tokens)) {
      uniqueTokens = dedupeTokens(tokens);
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

    const dedupeKey = `general_${Date.now()}`;

    const message = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          priority: 'max',
          tag: dedupeKey,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          icon: 'logo'
        }
      },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      data: {
        type: 'general_notification',
        dedupeKey,
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
// ✅ SHOP STATUS NOTIFICATION (FIXED DEDUPE)
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

    const validTokens = validateTokens(dedupeTokens(tokens));

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
      ? 'Great news! We are now open and ready to serve you with fresh haircuts and styling services. Come visit us for your grooming needs!'
      : 'Thank you for your visit today! We are now closed and will reopen tomorrow with fresh energy and great service. See you soon!';

    const dedupeKey = `shop_status_${isOpen ? 'open' : 'closed'}_${new Date().toISOString().slice(0, 10)}`;

    console.log(`📤 Sending shop ${isOpen ? 'OPEN' : 'CLOSED'} to ${validTokens.length} valid users`);

    const message = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'shop_status_channel',
          sound: 'default',
          priority: 'max',
          tag: dedupeKey,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          icon: 'logo'
        }
      },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      data: {
        type: 'shop_status',
        dedupeKey,
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
// ✅ GROUP CHAT NOTIFICATION (ROLE FILTERED + FIXED DEDUPE)
// =========================
async function sendGroupChatNotificationRoleFiltered({ chatDocId, senderId, senderName, messageType, message }) {
  const senderRole = await getUserRoleById(senderId);

  const snap = await db.collection('fcm_tokens').get();
  const tokens = [];

  snap.forEach(doc => {
    const data = doc.data() || {};
    const recipientUserId = (data.userId || doc.id || '').toString();
    const recipientRole = (data.role || 'user').toString();
    const token = (data.token || '').toString();

    if (!token || token.length < 100) return;

    if (shouldSkipRecipient({
      senderId,
      senderRole,
      recipientUserId,
      recipientRole
    })) return;

    tokens.push(token);
  });

  const validTokens = validateTokens(dedupeTokens(tokens));
  if (validTokens.length === 0) {
    console.log('⚠️ No valid recipients after role filtering (group chat).');
    return { successCount: 0, failureCount: 0 };
  }

  const title = (senderName && senderName.trim()) ? senderName.trim() : 'New message';

  let body = (message || '').trim();
  if (messageType === 'image') body = 'sent a photo';
  if (messageType === 'video') body = 'sent a video';
  if (!body) body = 'sent a message';

  const chunks = chunkArray(validTokens, 500);

  let totalSuccess = 0;
  let totalFailure = 0;

  const dedupeKey = chatDocId ? `group_chat_${chatDocId}` : `group_chat_${Date.now()}`;

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
          tag: dedupeKey
        }
      },
      apns: { payload: { aps: { sound: 'default' } } },
      data: {
        type: 'group_chat',
        dedupeKey,
        chatDocId: (chatDocId || '').toString(),
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

          const claimed = await claimNotificationLock(doc.ref);
          if (!claimed) continue;

          const messageType = (data.messageType || 'text').toString();

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
// AUTO-CLOSE SHOP (your full logic) - uses shop dedupe too
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
      const tokens = [];

      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.token) tokens.push(data.token);
      });

      const validTokens = validateTokens(dedupeTokens(tokens));

      if (validTokens.length > 0) {
        const title = 'Shop is Now CLOSED';
        const body = 'Thank you for your visit today! We are now closed and will reopen tomorrow with fresh energy and great service. See you soon!';

        const dedupeKey = `shop_status_closed_${new Date().toISOString().slice(0, 10)}_auto`;

        console.log(`📤 Auto-close: Sending notification to ${validTokens.length} users`);

        const message = {
          notification: { title, body },
          android: {
            priority: 'high',
            notification: {
              channelId: 'shop_status_channel',
              sound: 'default',
              priority: 'max',
              tag: dedupeKey,
              clickAction: 'FLUTTER_NOTIFICATION_CLICK',
              icon: 'logo'
            }
          },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
          data: {
            type: 'shop_status',
            dedupeKey,
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
      bookingStatusNotifications: true,
      bookingRequestNotificationsToAdmins: true,
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

  listenGroupChatNotifications();
  listenBookingStatusNotifications();
  listenNewBookingRequestNotifications();
});

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
