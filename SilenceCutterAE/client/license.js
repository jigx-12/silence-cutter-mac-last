// license.js — runs in the CEP panel's Node context.
// Verifies license keys against Gumroad's built-in license API. No custom
// server to run — Gumroad generates and hosts everything.
//
// SETUP (one-time, on your Gumroad product):
//   1. Create your product on Gumroad.
//   2. In the product's "Content" tab, enable "Generate a unique license
//      key per sale". Gumroad then emails a key to every buyer automatically.
//   3. Once that's enabled, Gumroad shows a "product_id" field right there
//      (a short alphanumeric string, NOT the URL permalink — Gumroad's
//      verify API requires product_id for any product created after
//      Jan 9, 2023, which is every product you're creating now).
//   4. Set GUMROAD_PRODUCT_ID below to that value.
// That's it. No server, no deployment.

const GUMROAD_PRODUCT_ID = "3Bfc7YZCt0BnB7DjAwZefQ=="; // Silencecutterae product ID

const MAX_ACTIVATIONS = 1; // how many machines a single key can be used on
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days offline grace

function getConfigDir() {
  const os = require("os");
  const path = require("path");
  return path.join(os.homedir(), ".silence-cutter");
}
function getConfigPath() {
  const path = require("path");
  return path.join(getConfigDir(), "license.json");
}
function readConfig() {
  const fs = require("fs");
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  } catch (e) {
    return null;
  }
}
function writeConfig(cfg) {
  const fs = require("fs");
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), "utf8");
}

// POSTs application/x-www-form-urlencoded, as Gumroad's API expects.
function postForm(url, params) {
  const https = require("https");
  const { URL } = require("url");
  const u = new URL(url);
  const data = Object.keys(params)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
    .join("&");

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 10000,
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(chunks) });
          } catch (e) {
            reject(new Error("Bad response from Gumroad: " + chunks.slice(0, 200)));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("License check timed out")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// One call to Gumroad's verify endpoint. incrementUses should only be true
// the FIRST time a given install activates a key (so re-opening the panel
// later doesn't keep inflating the shared "uses" counter across all of a
// key's activations).
async function verifyWithGumroad(key, incrementUses) {
  const res = await postForm("https://api.gumroad.com/v2/licenses/verify", {
    product_id: GUMROAD_PRODUCT_ID,
    license_key: key,
    increment_uses_count: incrementUses ? "true" : "false",
  });

  if (!res.body.success) {
    return { valid: false, reason: res.body.message || "not_found" };
  }
  const purchase = res.body.purchase || {};
  if (purchase.refunded || purchase.chargebacked || purchase.disputed) {
    return { valid: false, reason: "refunded_or_disputed" };
  }
  if (typeof res.body.uses === "number" && res.body.uses > MAX_ACTIVATIONS) {
    return { valid: false, reason: "max_activations" };
  }
  return { valid: true, uses: res.body.uses };
}

// Returns { status: "valid" | "invalid" | "unlicensed" | "offline_grace", reason? }
async function checkLicense() {
  const cfg = readConfig() || {};
  if (!cfg.key) return { status: "unlicensed" };

  try {
    // Already activated from this install before -> don't increment again,
    // just reconfirm the key is still good (catches refunds/chargebacks).
    const result = await verifyWithGumroad(cfg.key, !cfg.hasIncremented);
    if (result.valid) {
      cfg.hasIncremented = true;
      cfg.lastVerified = Date.now();
      cfg.lastStatus = "valid";
      writeConfig(cfg);
      return { status: "valid" };
    } else {
      cfg.lastStatus = "invalid";
      cfg.lastReason = result.reason;
      writeConfig(cfg);
      return { status: "invalid", reason: result.reason };
    }
  } catch (e) {
    if (cfg.lastStatus === "valid" && cfg.lastVerified && Date.now() - cfg.lastVerified < GRACE_PERIOD_MS) {
      return { status: "offline_grace" };
    }
    return { status: "invalid", reason: "offline_and_no_grace: " + e.message };
  }
}

// Called when the user pastes a key into the panel and clicks Activate.
async function activate(key) {
  const cleanKey = (key || "").trim();
  if (!cleanKey) return { status: "invalid", reason: "empty_key" };

  const result = await verifyWithGumroad(cleanKey, true); // first activation from this install
  if (result.valid) {
    writeConfig({ key: cleanKey, hasIncremented: true, lastVerified: Date.now(), lastStatus: "valid" });
    return { status: "valid" };
  }
  return { status: "invalid", reason: result.reason };
}

module.exports = { checkLicense, activate, GUMROAD_PRODUCT_ID };
