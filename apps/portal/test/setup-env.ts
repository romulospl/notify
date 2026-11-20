// Test-only values. In CI, DATABASE_URL comes from the job (service Postgres).
process.env.DATABASE_URL ??= "postgresql://stellytics:stellytics@localhost:5432/stellytics";
process.env.BETTER_AUTH_SECRET ??= "test-only-secret-with-enough-entropy-0123456789";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.UMAMI_API_KEY ??= "umami_test-only-key";
