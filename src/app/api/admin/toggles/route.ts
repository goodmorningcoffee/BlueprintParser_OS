import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getToggles, setToggle, hasTogglePassword, setTogglePassword, verifyTogglePassword } from "@/lib/toggles";

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const toggles = await getToggles();
  const hasPassword = await hasTogglePassword();

  return NextResponse.json({
    sagemakerEnabled: toggles.sagemakerEnabled,
    quotaEnabled: toggles.quotaEnabled,
    hasPassword,
  });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await req.json();

  // Set or change the toggle password
  if (body.action === "set-password") {
    const { newPassword, currentPassword } = body;
    if (!newPassword || newPassword.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }
    const result = await setTogglePassword(newPassword, currentPassword);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }
    return NextResponse.json({ success: true });
  }

  // Toggle a setting
  const { toggle, enabled, password } = body;

  if (!toggle || typeof enabled !== "boolean" || !password) {
    return NextResponse.json({ error: "toggle, enabled, and password required" }, { status: 400 });
  }

  if (toggle !== "sagemaker" && toggle !== "quota") {
    return NextResponse.json({ error: "Invalid toggle" }, { status: 400 });
  }

  // Verify the independent toggle password
  const hasPass = await hasTogglePassword();
  if (!hasPass) {
    return NextResponse.json({ error: "Toggle password not set. Set it first." }, { status: 400 });
  }

  const valid = await verifyTogglePassword(password);
  if (!valid) {
    return NextResponse.json({ error: "Invalid toggle password" }, { status: 401 });
  }

  const key = toggle === "sagemaker" ? "sagemakerEnabled" : "quotaEnabled";
  const updated = await setToggle(key, enabled);

  return NextResponse.json({
    success: true,
    sagemakerEnabled: updated.sagemakerEnabled,
    quotaEnabled: updated.quotaEnabled,
  });
}
