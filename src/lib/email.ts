import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({ region: process.env.AWS_REGION || "us-east-1" });
const FROM_EMAIL = process.env.SES_FROM_EMAIL || "noreply@example.com";

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await ses.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: "Reset your BlueprintParser password" },
      Body: {
        Html: {
          Data: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="color:#333">Password Reset</h2>
            <p>You requested a password reset for your BlueprintParser account.</p>
            <p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Reset Password</a></p>
            <p style="color:#666;font-size:13px">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
          </div>`
        },
        Text: { Data: `Reset your BlueprintParser password:\n\n${resetUrl}\n\nThis link expires in 1 hour.` },
      },
    },
  }));
}

/**
 * Generic best-effort alert email to a single recipient (e.g. ROOT_ADMIN_EMAIL).
 * Reuses the shared SES client + FROM_EMAIL. Callers MUST wrap in try/catch so a
 * mail failure never breaks the request flow. The plain-text part is derived
 * from the HTML by stripping tags.
 */
export async function sendAlertEmail(to: string, subject: string, html: string): Promise<void> {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  await ses.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: {
        Html: { Data: html },
        Text: { Data: text },
      },
    },
  }));
}
