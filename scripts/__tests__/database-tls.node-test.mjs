import assert from "node:assert/strict";
import test from "node:test";
import {
  AWS_RDS_CA_BUNDLE_PATH,
  databaseTlsOptions,
} from "../database-tls.mjs";

const PRODUCTION_DATABASE_URL =
  "postgresql://beaver_admin:secret@beaver-db.example.us-east-1.rds.amazonaws.com:5432/beaver";

test("local and test processes do not require the production RDS bundle", () => {
  let reads = 0;
  const options = databaseTlsOptions({ NODE_ENV: "test" }, () => {
    reads += 1;
    return "";
  });
  assert.equal(options, undefined);
  assert.equal(reads, 0);
});

test("production verifies the server with the code-owned RDS trust path", () => {
  const reads = [];
  const options = databaseTlsOptions(
    { NODE_ENV: "production", DATABASE_URL: PRODUCTION_DATABASE_URL },
    (...args) => {
      reads.push(args);
      return "-----BEGIN CERTIFICATE-----\ntrusted\n-----END CERTIFICATE-----\n";
    },
  );
  assert.deepEqual(reads, [[AWS_RDS_CA_BUNDLE_PATH, "utf8"]]);
  assert.deepEqual(options, {
    ca: "-----BEGIN CERTIFICATE-----\ntrusted\n-----END CERTIFICATE-----\n",
    rejectUnauthorized: true,
  });
});

test("production fails closed on missing or malformed trust material", () => {
  assert.throws(
    () =>
      databaseTlsOptions(
        { NODE_ENV: "production", DATABASE_URL: PRODUCTION_DATABASE_URL },
        () => {
          throw new Error("ENOENT");
        },
      ),
    /ENOENT/,
  );

  assert.throws(
    () =>
      databaseTlsOptions(
        { NODE_ENV: "production", DATABASE_URL: PRODUCTION_DATABASE_URL },
        () => "not a CA",
      ),
    /missing or malformed/,
  );
});

test("production rejects every node-postgres connection-string override channel", () => {
  const rejected = [
    `${PRODUCTION_DATABASE_URL}?sslmode=no-verify`,
    `${PRODUCTION_DATABASE_URL}?sslmode=disable`,
    `${PRODUCTION_DATABASE_URL}?sslrootcert=/etc/ssl/certs/ca-certificates.crt`,
    `${PRODUCTION_DATABASE_URL}?host=attacker.example`,
    `${PRODUCTION_DATABASE_URL}?options=-csearch_path%3Devil`,
    `${PRODUCTION_DATABASE_URL}#ignored-fragment`,
  ];

  for (const DATABASE_URL of rejected) {
    let reads = 0;
    assert.throws(
      () =>
        databaseTlsOptions(
          { NODE_ENV: "production", DATABASE_URL },
          () => {
            reads += 1;
            return "-----BEGIN CERTIFICATE-----\ntrusted\n-----END CERTIFICATE-----\n";
          },
        ),
      /no query or fragment/,
      DATABASE_URL,
    );
    assert.equal(reads, 0, DATABASE_URL);
  }
});

test("production accepts only the canonical hierarchical URL shape", () => {
  const rejected = [
    undefined,
    "not-a-url",
    PRODUCTION_DATABASE_URL.replace("postgresql:", "postgres:"),
    PRODUCTION_DATABASE_URL.replace("beaver_admin:secret@", ""),
    PRODUCTION_DATABASE_URL.replace(":5432", ""),
    PRODUCTION_DATABASE_URL.replace("/beaver", "/beaver/other"),
  ];

  for (const DATABASE_URL of rejected) {
    assert.throws(
      () =>
        databaseTlsOptions(
          { NODE_ENV: "production", DATABASE_URL },
          () => "-----BEGIN CERTIFICATE-----\ntrusted\n-----END CERTIFICATE-----\n",
        ),
      /Production DATABASE_URL/,
      String(DATABASE_URL),
    );
  }
});
