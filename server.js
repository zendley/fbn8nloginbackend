import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import User from "./models/User.js";

dotenv.config();

const {
  PORT = 5000,
  MONGO_URI,
  FB_APP_ID,
  FB_APP_SECRET,
  FRONTEND_URL,
  INTERNAL_API_KEY,
  N8N_WEBHOOK_URL
} = process.env;

const app = express();
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

await mongoose.connect(MONGO_URI);

// ---------- OAuth: send user to FB ----------

app.get("/auth/login", (req, res) => {
  const redirectUri = encodeURIComponent("https://fbloginbackend-us6u.vercel.app/auth/callback");
  const scope = encodeURIComponent(
    "public_profile,pages_manage_posts,pages_read_engagement,pages_show_list"
  );
  const url = `https://www.facebook.com/v23.0/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${redirectUri}&scope=${scope}&response_type=code`;
  res.redirect(url);
});

// ---------- OAuth: callback -> exchange tokens ----------
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  const redirectUri = "https://fbloginbackend-us6u.vercel.app/auth/callback";

  try {
    // 1) short-lived user token
    const tokenRes = await axios.get(
      "https://graph.facebook.com/v23.0/oauth/access_token",
      {
        params: {
          client_id: FB_APP_ID,
          client_secret: FB_APP_SECRET,
          redirect_uri: redirectUri,
          code
        }
      }
    );
    const slUserToken = tokenRes.data.access_token;

    // 2) long-lived user token
    const llRes = await axios.get(
      "https://graph.facebook.com/v23.0/oauth/access_token",
      {
        params: {
          grant_type: "fb_exchange_token",
          client_id: FB_APP_ID,
          client_secret: FB_APP_SECRET,
          fb_exchange_token: slUserToken
        }
      }
    );
    const llUserToken = llRes.data.access_token;
    const expiresInSec = llRes.data.expires_in ?? 60 * 24 * 60 * 60; // ~60 days
    const llUserTokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

    // 3) get user profile
    const me = await axios.get("https://graph.facebook.com/v23.0/me", {
      params: { fields: "id,name", access_token: llUserToken }
    });

    // 4) upsert user
    const user = await User.findOneAndUpdate(
      { facebookId: me.data.id },
      {
        facebookId: me.data.id,
        name: me.data.name,
        llUserToken,
        llUserTokenExpiresAt
      },
      { new: true, upsert: true }
    );

    // 5) redirect to frontend with userId (simple dev flow)
    res.redirect(`${FRONTEND_URL}/dashboard?userId=${user._id.toString()}`);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Auth failed");
  }
});

// ---------- Get pages this user manages ----------
app.get("/api/pages", async (req, res) => {
  const { userId } = req.query;
  try {
    const user = await User.findById(userId);
    if (!user?.llUserToken) return res.status(401).json({ error: "No token" });

    const pages = await axios.get(
      "https://graph.facebook.com/v23.0/me/accounts",
      { params: { access_token: user.llUserToken } }
    );

    // return only what UI needs
    res.json({
      data: pages.data.data.map(p => ({
        id: p.id,
        name: p.name
      }))
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch pages" });
  }
});

// ---------- Trigger n8n to post ----------
app.post("/api/queue-post", async (req, res) => {
  const { userId, pageId, message } = req.body;
  if (!userId || !pageId || !message)
    return res.status(400).json({ error: "Missing fields" });

  try {
    const user = await User.findById(userId);
    if (!user?.llUserToken) return res.status(401).json({ error: "No token" });

    // Send minimal data to n8n; n8n will fetch page token itself
    const payload = {
      userId,
      fbUserToken: user.llUserToken, // long-lived user token
      pageId,
      message
    };

    await axios.post(N8N_WEBHOOK_URL, payload, {
      headers: { "x-internal-key": INTERNAL_API_KEY }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to trigger n8n" });
  }
});

// ---------- internal endpoint (optional) for n8n to re-fetch token by userId ----------
app.get("/internal/user-token", async (req, res) => {
  const key = req.headers["x-internal-key"];
  if (key !== INTERNAL_API_KEY) return res.status(401).json({ error: "nope" });

  const { userId } = req.query;
  const user = await User.findById(userId);
  if (!user?.llUserToken) return res.status(404).json({ error: "not found" });

  res.json({ llUserToken: user.llUserToken });
});



app.get("/", (req, res) => {
  res.send("Hello From Professional Chatbot Server!");
});

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.listen(PORT, () =>
  console.log(`API running on http://localhost:${PORT}`)
);
