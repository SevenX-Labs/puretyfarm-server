import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient();

async function main() {
  // 1. Ensure Supabase PostgREST roles retain public schema usage & table permissions
  // (Prevents "42501 permission denied for schema public" after prisma migrate reset)
  try {
    const grantCommands = [
      "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role",
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role",
      "GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role",
      "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO anon, authenticated, service_role",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role",
      "NOTIFY pgrst, 'reload schema'",
    ];

    for (const sql of grantCommands) {
      await prisma.$executeRawUnsafe(sql);
    }
    console.log("[SEED] Supabase schema permissions granted & PostgREST notified.");
  } catch (err: any) {
    console.warn("[SEED] Note: Could not grant Supabase permissions:", err?.message);
  }

  // 2. Seed initial Admin
  const email = "admin@puretyfarm.in";
  const initialPassword = "puretyfarm@2026";

  const existing = await prisma.admin.findUnique({
    where: { email },
  });

  if (existing) {
    console.log(`[SEED] Admin already exists with ID: ${existing.id}`);
    console.log(
      `[SEED] Skipping password overwrite. Existing password remains unchanged.`
    );
    return existing;
  }

  const passwordHash = await argon2.hash(initialPassword);
  const admin = await prisma.admin.create({
    data: {
      email,
      passwordHash,
      isActive: true,
    },
  });

  console.log(`[SEED] Successfully created initial Admin!`);
  console.log(`[SEED] Email: ${admin.email}`);
  console.log(`[SEED] Admin ID: ${admin.id}`);
  return admin;
}

main()
  .catch((e) => {
    console.error("[SEED] Failed to seed database:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
