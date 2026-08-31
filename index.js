/**
 * Pallavan Polytechnic College — Fee Portal
 * Email notifications (replaces EmailJS) — Cloudflare Worker edition
 *
 * Same 3 triggers, same email content as the Firebase Functions version —
 * just hosted on Cloudflare instead, since Cloudflare Workers' free tier
 * (100,000 requests/day) allows calling external APIs without needing a
 * billing account, unlike Firebase's Spark plan.
 *
 * One Worker, three routes (POST):
 *   /notifyPendingPayment    — student submits a payment → email ADMIN, "needs verification"
 *   /notifyPaymentConfirmed  — admin verifies a payment  → email STUDENT + ADMIN, receipt PDF attached
 *   /notifyPaymentRejected   — admin rejects a payment   → email STUDENT
 *
 * Setup (one-time):
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. cd cloudflare-worker
 *   4. wrangler secret put BREVO_API_KEY   → paste your Brevo API key
 *   5. wrangler deploy
 *   Wrangler prints a URL like:
 *     https://ppt-fee-portal-email.<your-subdomain>.workers.dev
 *   Put that URL into CLOUD_FN_BASE in index.html.
 */

// ── Fixed college details (same as the Firebase version) ──
const COLLEGE_NAME = "Pallavan Polytechnic College";
const COLLEGE_ADDR = "Kolivakkam, Kanchipuram, Tamil Nadu – 631 502";
const ADMIN_EMAIL  = "pallavanppt86@gmail.com"; // same account used for admin login
const FROM_EMAIL   = "pallavanppt86@gmail.com"; // must be verified as a sender in Brevo

// ── Allowed origins (hardening) ──
// Only your own site should be able to call this Worker from a browser.
// Add every origin your site is actually served from (GitHub Pages, a
// custom domain if you add one later, localhost while testing, etc).
// IMPORTANT: replace the GitHub Pages placeholder below with your real URL.
const ALLOWED_ORIGINS = [
  "https://prathikmothilal.github.io", // your GitHub Pages origin (no path, no trailing slash)
  "http://localhost:5500",             // convenient for local testing — remove if unused
];

function corsHeadersFor(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-PPT-Secret",
    "Vary": "Origin",
  };
}

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// Shared brand colors — same purple/gold used across the site + PDF receipt
const ROYAL = "#3B1F7A";
const GOLD  = "#C9A84C";

async function sendMail(env, { to, subject, html, attachments }) {
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      sender: { name: COLLEGE_NAME, email: FROM_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      attachment: (attachments || []).map(a => ({
        name: a.filename,
        content: a.content, // base64 string
      })),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Brevo error ${resp.status}: ${text}`);
  }
  return resp.json().catch(() => ({}));
}

// ── Shared email shell — purple header + gold rule, matches site/PDF branding ──
function emailShell({ bodyHtml }) {
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;max-width:600px;margin:0 auto;background:#FAF8F3;">
    <div style="background:${ROYAL};padding:24px 20px;text-align:center;">
      <h1 style="color:#fff;font-size:20px;margin:0;letter-spacing:0.5px;">${COLLEGE_NAME.toUpperCase()}</h1>
      <p style="color:${GOLD};font-size:12px;margin:6px 0 0;">${COLLEGE_ADDR}</p>
    </div>
    <div style="height:3px;background:${GOLD};"></div>
    <div style="padding:24px 20px;color:#2A2A2A;font-size:14px;line-height:1.6;">
      ${bodyHtml}
    </div>
    <div style="padding:14px 20px;text-align:center;color:#8A8A8A;font-size:11px;border-top:1px solid #E5E0D5;">
      This is an automated message from the ${COLLEGE_NAME} fee portal.
    </div>
  </div>`;
}

function detailsTable(rows) {
  return `
  <table style="width:100%;border-collapse:collapse;margin:14px 0;">
    ${rows.map(([label, value]) => `
      <tr>
        <td style="padding:6px 0;color:#6B6B6B;width:45%;">${label}</td>
        <td style="padding:6px 0;color:#1A1A1A;font-weight:bold;">${value}</td>
      </tr>`).join("")}
  </table>`;
}

// ══════════════════════════════════════════════
// 1. Admin notification — payment submitted, needs verification
// ══════════════════════════════════════════════
async function notifyPendingPayment(req, env, corsHeaders) {
  const {
    student_name, app_id, course, study_year, mobile,
    amount, payment_for, reference_id, date_time, balance_due,
  } = await req.json();

  const html = emailShell({
    bodyHtml: `
      <p style="margin-top:0;">A student has submitted a fee payment that needs verification.</p>
      ${detailsTable([
        ["Student", student_name],
        ["App ID", app_id],
        ["Course", course],
        ["Study Year", study_year],
        ["Mobile", mobile],
        ["Amount", `Rs. ${amount}`],
        ["Payment For", payment_for],
        ["Reference ID", reference_id],
        ["Submitted", date_time],
        ["Balance Due", `Rs. ${balance_due}`],
      ])}
      <p style="margin-bottom:0;">Please log in to the admin dashboard to verify this payment against your bank/UPI statement.</p>
    `,
  });

  await sendMail(env, {
    to: ADMIN_EMAIL,
    subject: `🔔 Payment Needs Verification — ${student_name} (₹${amount})`,
    html,
  });

  return jsonResponse({ ok: true }, 200, corsHeaders);
}

// ══════════════════════════════════════════════
// 2. Payment confirmed — email STUDENT + ADMIN, receipt PDF attached
// ══════════════════════════════════════════════
async function notifyPaymentConfirmed(req, env, corsHeaders) {
  const {
    student_email, student_name, app_id, course, study_year,
    amount, payment_for, reference_id, date_time, balance_due,
    receipt_pdf_base64, receipt_filename,
  } = await req.json();

  const statusBg    = "#EAF5EE";
  const statusColor = "#1B6B3A";
  const statusMsg   = `✅ Your payment of ₹${amount} has been confirmed!`;
  const bodyText    = "Your fee payment has been verified and confirmed by " + COLLEGE_NAME + ". Please find the details below.";
  const footerNote  = "📄 Your official fee receipt is attached to this email as a PDF.";

  const bodyHtml = `
    <p style="margin-top:0;">Dear ${student_name},</p>
    <div style="background:${statusBg};color:${statusColor};padding:12px 16px;border-radius:6px;font-weight:bold;margin:14px 0;">
      ${statusMsg}
    </div>
    <p>${bodyText}</p>
    ${detailsTable([
      ["App ID", app_id],
      ["Course", course],
      ["Study Year", study_year],
      ["Amount", `Rs. ${amount}`],
      ["Payment For", payment_for],
      ["Reference ID", reference_id],
      ["Date", date_time],
      ["Balance Due", `Rs. ${balance_due}`],
    ])}
    <p style="margin-bottom:0;">${footerNote}</p>
  `;

  const html = emailShell({ bodyHtml });
  const subject = `✅ Payment Confirmed — ₹${amount}`;

  const attachments = receipt_pdf_base64
    ? [{ filename: receipt_filename || "receipt.pdf", content: receipt_pdf_base64 }]
    : [];

  if (student_email) {
    await sendMail(env, { to: student_email, subject, html, attachments });
  }

  await sendMail(env, {
    to: ADMIN_EMAIL,
    subject: `[Copy] ${subject} — ${student_name} (${app_id})`,
    html,
    attachments,
  });

  return jsonResponse({ ok: true }, 200, corsHeaders);
}

// ══════════════════════════════════════════════
// 3. Payment rejected — email STUDENT
// ══════════════════════════════════════════════
async function notifyPaymentRejected(req, env, corsHeaders) {
  const {
    student_email, student_name, app_id, course, study_year,
    amount, payment_for, reference_id, date_time, balance_due,
  } = await req.json();

  if (!student_email) {
    return jsonResponse({ ok: true, skipped: true }, 200, corsHeaders);
  }

  const statusBg    = "#FBF0F0";
  const statusColor = "#8B1A1A";
  const statusMsg   = `⚠️ Your payment of ₹${amount} could not be verified`;
  const bodyText    = "We were unable to verify your payment. This could be because the payment was not received in our account, or the amount did not match. Please contact the college office with your transaction screenshot.";
  const footerNote  = "📞 Please visit or contact " + COLLEGE_NAME + ", Kolivakkam with your UPI transaction screenshot for assistance.";

  const bodyHtml = `
    <p style="margin-top:0;">Dear ${student_name},</p>
    <div style="background:${statusBg};color:${statusColor};padding:12px 16px;border-radius:6px;font-weight:bold;margin:14px 0;">
      ${statusMsg}
    </div>
    <p>${bodyText}</p>
    ${detailsTable([
      ["App ID", app_id],
      ["Course", course],
      ["Study Year", study_year],
      ["Amount", `Rs. ${amount}`],
      ["Payment For", payment_for],
      ["Reference ID", reference_id],
      ["Date", date_time],
      ["Balance Due", `Rs. ${balance_due}`],
    ])}
    <p style="margin-bottom:0;">${footerNote}</p>
  `;

  const html = emailShell({ bodyHtml });

  await sendMail(env, {
    to: student_email,
    subject: "⚠️ Payment Not Verified — Please Contact College",
    html,
  });

  return jsonResponse({ ok: true }, 200, corsHeaders);
}

// ── Router ──
const ROUTES = {
  "/notifyPendingPayment": notifyPendingPayment,
  "/notifyPaymentConfirmed": notifyPaymentConfirmed,
  "/notifyPaymentRejected": notifyPaymentRejected,
};

export default {
  async fetch(request, env) {
    const corsHeaders = corsHeadersFor(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
    }

    // Shared-secret check — a lightweight speed bump so the endpoint can't
    // be trivially scripted from outside your own app. Set with:
    //   wrangler secret put PPT_SHARED_SECRET
    // and the client sends the same value back in the X-PPT-Secret header
    // (see CLOUD_FN_SECRET in index.html). This is NOT a substitute for
    // real auth — anyone who reads your page source can find it — but it
    // stops casual scanning/abuse of your Brevo quota from random bots.
    if (env.PPT_SHARED_SECRET) {
      const provided = request.headers.get("X-PPT-Secret") || "";
      if (provided !== env.PPT_SHARED_SECRET) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401, corsHeaders);
      }
    }

    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    if (!handler) {
      return jsonResponse({ ok: false, error: "Unknown route" }, 404, corsHeaders);
    }

    try {
      return await handler(request, env, corsHeaders);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500, corsHeaders);
    }
  },
};
