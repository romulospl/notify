// Valores só de teste. No CI, DATABASE_URL vem do job (Postgres de serviço).
process.env.DATABASE_URL ??= "postgresql://notify:notify@localhost:5432/notify";
process.env.BETTER_AUTH_SECRET ??= "test-only-secret-with-enough-entropy-0123456789";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
