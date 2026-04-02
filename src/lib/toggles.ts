import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "@/lib/logger";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

const S3_BUCKET = process.env.S3_BUCKET || "beaver-public";
const TOGGLES_KEY = "config/toggles.json";
const CACHE_TTL = 60_000;

interface ToggleState {
  sagemakerEnabled: boolean;
  quotaEnabled: boolean;
  passwordHash: string | null; // bcrypt hash of the independent toggle password
}

const DEFAULTS: ToggleState = { sagemakerEnabled: true, quotaEnabled: true, passwordHash: null };

let cache: { data: ToggleState; expiry: number } | null = null;

async function readFromS3(): Promise<ToggleState> {
  try {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: TOGGLES_KEY }));
    const body = await res.Body?.transformToString();
    if (body) return { ...DEFAULTS, ...JSON.parse(body) };
  } catch (err: any) {
    if (err?.name !== "NoSuchKey") logger.warn("Failed to read toggles:", err?.message);
  }
  return { ...DEFAULTS };
}

async function writeToS3(state: ToggleState): Promise<void> {
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: TOGGLES_KEY,
    Body: JSON.stringify(state, null, 2),
    ContentType: "application/json",
  }));
  cache = { data: state, expiry: Date.now() + CACHE_TTL };
}

/** Read toggles (cached 60s). Pass fresh=true to bypass cache for safety-critical checks. */
export async function getToggles(fresh = false): Promise<ToggleState> {
  if (!fresh && cache && Date.now() < cache.expiry) return { ...cache.data };
  const data = await readFromS3();
  cache = { data, expiry: Date.now() + CACHE_TTL };
  return { ...data };
}

/** Update a toggle value. Caller must verify password first. */
export async function setToggle(key: "sagemakerEnabled" | "quotaEnabled", value: boolean): Promise<ToggleState> {
  const current = await readFromS3();
  const updated = { ...current, [key]: value };
  await writeToS3(updated);
  return updated;
}

/** Check if a toggle password has been set */
export async function hasTogglePassword(): Promise<boolean> {
  const state = await getToggles();
  return state.passwordHash !== null;
}

/** Set the toggle password (first time or change). Returns true on success. */
export async function setTogglePassword(newPassword: string, currentPassword?: string): Promise<{ success: boolean; error?: string }> {
  const bcrypt = (await import("bcrypt")).default;
  const state = await readFromS3();

  // If password already set, verify current password first
  if (state.passwordHash) {
    if (!currentPassword) return { success: false, error: "Current toggle password required" };
    const valid = await bcrypt.compare(currentPassword, state.passwordHash);
    if (!valid) return { success: false, error: "Invalid current toggle password" };
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await writeToS3({ ...state, passwordHash: hash });
  return { success: true };
}

/** Verify the toggle password */
export async function verifyTogglePassword(password: string): Promise<boolean> {
  const bcrypt = (await import("bcrypt")).default;
  const state = await getToggles();
  if (!state.passwordHash) return false;
  return bcrypt.compare(password, state.passwordHash);
}
