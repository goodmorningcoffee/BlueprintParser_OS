import { readFileSync } from "node:fs";

// The runner image installs the official AWS RDS global trust bundle here.
// Keep this path code-owned: an environment override could redirect production
// verification to an attacker-controlled CA file.
export const AWS_RDS_CA_BUNDLE_PATH =
  "/etc/ssl/certs/aws-rds-global-bundle.pem";

function validateProductionDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Production DATABASE_URL is not a valid PostgreSQL URL");
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("Production DATABASE_URL has an invalid database name");
  }

  // node-postgres parses connectionString after the explicit Pool options. URL
  // query parameters such as sslmode, sslrootcert, host, and options therefore
  // override the code-owned CA/verification and can alter search_path. Refuse
  // the entire override channel before pg sees the string.
  if (
    url.protocol !== "postgresql:" ||
    url.username === "" ||
    url.password === "" ||
    url.hostname === "" ||
    url.port !== "5432" ||
    !/^\/[^/]+$/u.test(url.pathname) ||
    databaseName === "" ||
    databaseName.includes("/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Production DATABASE_URL must be a credentialed postgresql URL with explicit port 5432, one database name, and no query or fragment",
    );
  }
}

/**
 * Return the only permitted production PostgreSQL TLS configuration.
 *
 * Local development/tests keep their existing plaintext loopback behavior.
 * Production fails closed if the image is missing the reviewed trust bundle;
 * it may never silently fall back to encryption without server authentication.
 */
export function databaseTlsOptions(
  env = process.env,
  readTrustedBundle = readFileSync,
) {
  if (env.NODE_ENV !== "production") return undefined;

  validateProductionDatabaseUrl(env.DATABASE_URL);

  const ca = readTrustedBundle(AWS_RDS_CA_BUNDLE_PATH, "utf8");
  if (
    typeof ca !== "string" ||
    !ca.includes("-----BEGIN CERTIFICATE-----") ||
    !ca.includes("-----END CERTIFICATE-----")
  ) {
    throw new Error("AWS RDS CA bundle is missing or malformed");
  }

  return {
    ca,
    rejectUnauthorized: true,
  };
}
