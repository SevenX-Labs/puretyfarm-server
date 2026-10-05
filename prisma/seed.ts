import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const email = 'admin@puretyfarm.in';
  const initialPassword = 'puretyfarm@2026';

  const existing = await prisma.admin.findUnique({
    where: { email },
  });

  if (existing) {
    console.log(`[SEED] Admin already exists with ID: ${existing.id}`);
    console.log(
      `[SEED] Skipping password overwrite. Existing password remains unchanged.`,
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
    console.error('[SEED] Failed to seed database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
