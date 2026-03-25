import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inviteRequests } from "@/lib/db/schema";

export async function POST(req: Request) {
  try {
    const { email, name, company } = await req.json();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== "string" || !emailRegex.test(email) || email.length > 254) {
      return NextResponse.json({ error: "Valid email required" }, { status: 400 });
    }

    await db.insert(inviteRequests).values({
      email: email.trim().toLowerCase().slice(0, 254),
      name: name?.trim()?.slice(0, 100) || null,
      company: company?.trim()?.slice(0, 100) || null,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to create invite request:", err);
    return NextResponse.json({ error: "Failed to submit" }, { status: 500 });
  }
}
