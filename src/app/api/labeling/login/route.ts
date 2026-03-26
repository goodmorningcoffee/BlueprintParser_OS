import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * GET /api/labeling/login?redirect=/projects/123
 *
 * Auto-login relay for Label Studio (HDED pattern).
 * Server-side CSRF form login → extract session cookie → set on browser → redirect.
 */
export async function GET(req: Request) {
  console.log("[LS-LOGIN] Endpoint hit");

  const session = await auth();
  if (!session?.user) {
    console.log("[LS-LOGIN] No auth session");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log("[LS-LOGIN] Authenticated as:", session.user.email);

  const url = new URL(req.url);
  const redirect = url.searchParams.get("redirect") || "/";

  const lsUrl = process.env.LABEL_STUDIO_URL;
  const lsEmail = process.env.LABEL_STUDIO_ADMIN_EMAIL;
  const lsPassword = process.env.LABEL_STUDIO_ADMIN_PASSWORD;

  console.log("[LS-LOGIN] Config:", {
    lsUrl: lsUrl ? "set" : "MISSING",
    lsEmail: lsEmail ? "set" : "MISSING",
    lsPassword: lsPassword ? "set" : "MISSING",
    redirect,
  });

  if (!lsUrl || !lsEmail || !lsPassword) {
    return NextResponse.json(
      { error: "Label Studio not configured", details: { lsUrl: !!lsUrl, lsEmail: !!lsEmail, lsPassword: !!lsPassword } },
      { status: 503 }
    );
  }

  try {
    // Step 1: GET login page for CSRF token
    console.log("[LS-LOGIN] Step 1: Fetching CSRF token from", `${lsUrl}/user/login/`);
    const loginPageRes = await fetch(`${lsUrl}/user/login/`, {
      redirect: "manual",
      headers: { "User-Agent": "BlueprintParser/1.0" },
    });
    console.log("[LS-LOGIN] Login page response:", loginPageRes.status);

    // Parse Set-Cookie headers — use raw header since getSetCookie may not exist
    const rawSetCookie = loginPageRes.headers.get("set-cookie") || "";
    console.log("[LS-LOGIN] Raw Set-Cookie length:", rawSetCookie.length, "first 200:", rawSetCookie.slice(0, 200));

    // Extract csrftoken — could be in a multi-value header separated by commas
    const csrfMatch = rawSetCookie.match(/csrftoken=([^;,\s]+)/);
    const csrfToken = csrfMatch ? csrfMatch[1] : "";

    if (!csrfToken) {
      // Try getSetCookie if available
      let found = false;
      if (typeof loginPageRes.headers.getSetCookie === "function") {
        const cookies = loginPageRes.headers.getSetCookie();
        console.log("[LS-LOGIN] getSetCookie returned", cookies.length, "cookies");
        for (const c of cookies) {
          const m = c.match(/csrftoken=([^;]+)/);
          if (m) {
            console.log("[LS-LOGIN] Found CSRF via getSetCookie");
            found = true;
            // Use this token
            return doLogin(lsUrl, lsEmail, lsPassword, m[1], redirect, req);
          }
        }
      }

      if (!found) {
        // Also try reading from response body — LS might embed CSRF in HTML
        const html = await loginPageRes.text().catch(() => "");
        const htmlMatch = html.match(/csrfmiddlewaretoken['"]?\s*(?:value=|:)\s*['"]([^'"]+)['"]/i);
        if (htmlMatch) {
          console.log("[LS-LOGIN] Found CSRF token in HTML body");
          return doLogin(lsUrl, lsEmail, lsPassword, htmlMatch[1], redirect, req);
        }

        console.error("[LS-LOGIN] No CSRF token found anywhere");
        return NextResponse.json({
          error: "No CSRF token from Label Studio",
          loginPageStatus: loginPageRes.status,
          setCookieHeader: rawSetCookie.slice(0, 500),
        }, { status: 502 });
      }
    }

    console.log("[LS-LOGIN] Got CSRF token:", csrfToken.slice(0, 10) + "...");
    return doLogin(lsUrl, lsEmail, lsPassword, csrfToken, redirect, req);

  } catch (err: any) {
    console.error("[LS-LOGIN] Fatal error:", err.message, err.stack);
    return NextResponse.json({
      error: "Auto-login failed",
      message: err.message,
    }, { status: 500 });
  }
}

async function doLogin(
  lsUrl: string,
  lsEmail: string,
  lsPassword: string,
  csrfToken: string,
  redirect: string,
  req: Request,
): Promise<NextResponse> {
  // Step 2: POST login form
  console.log("[LS-LOGIN] Step 2: POSTing login form");
  const loginRes = await fetch(`${lsUrl}/user/login/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `csrftoken=${csrfToken}`,
      Referer: `${lsUrl}/user/login/`,
      "User-Agent": "BlueprintParser/1.0",
    },
    body: new URLSearchParams({
      email: lsEmail,
      password: lsPassword,
      csrfmiddlewaretoken: csrfToken,
    }).toString(),
    redirect: "manual",
  });
  console.log("[LS-LOGIN] Login POST response:", loginRes.status);

  // Step 3: Extract sessionid cookie
  const loginRawCookie = loginRes.headers.get("set-cookie") || "";
  console.log("[LS-LOGIN] Login Set-Cookie length:", loginRawCookie.length, "first 200:", loginRawCookie.slice(0, 200));

  let sessionId = "";

  // Try raw header
  const sessionMatch = loginRawCookie.match(/sessionid=([^;,\s]+)/);
  if (sessionMatch) {
    sessionId = sessionMatch[1];
  }

  // Try getSetCookie
  if (!sessionId && typeof loginRes.headers.getSetCookie === "function") {
    for (const c of loginRes.headers.getSetCookie()) {
      const m = c.match(/sessionid=([^;]+)/);
      if (m) {
        sessionId = m[1];
        break;
      }
    }
  }

  if (!sessionId) {
    console.error("[LS-LOGIN] No sessionid in login response");
    return NextResponse.json({
      error: "Login succeeded but no session cookie returned",
      loginStatus: loginRes.status,
      setCookie: loginRawCookie.slice(0, 500),
    }, { status: 502 });
  }

  console.log("[LS-LOGIN] Got sessionid:", sessionId.slice(0, 10) + "...");

  // Step 4: Redirect browser with session cookie
  const targetUrl = `${lsUrl}${redirect.startsWith("/") ? redirect : "/" + redirect}`;
  console.log("[LS-LOGIN] Redirecting to:", targetUrl);

  const response = NextResponse.redirect(targetUrl);

  // Compute cookie domain
  const lsHost = new URL(lsUrl).hostname;
  const appHost = process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).hostname : "";
  const lsParts = lsHost.split(".");
  const appParts = appHost.split(".");
  let cookieDomain = "";

  if (lsParts.length >= 2 && appParts.length >= 2) {
    const lsParent = lsParts.slice(-2).join(".");
    const appParent = appParts.slice(-2).join(".");
    if (lsParent === appParent && lsParent !== "localhost") {
      cookieDomain = `.${lsParent}`;
    }
  }

  console.log("[LS-LOGIN] Cookie domain:", cookieDomain || "(default)");

  response.cookies.set("sessionid", sessionId, {
    domain: cookieDomain || undefined,
    path: "/",
    secure: lsUrl.startsWith("https"),
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 14,
  });

  console.log("[LS-LOGIN] Success — redirecting with session cookie");
  return response;
}
