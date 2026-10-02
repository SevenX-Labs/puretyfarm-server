import { PrismaClient } from '@prisma/client';

async function testConnection() {
  const prisma = new PrismaClient({
    log: ['query', 'info', 'warn', 'error'],
  });

  console.log('🔄 Attempting connection to Supabase PostgreSQL...');
  const start = Date.now();

  try {
    await prisma.$connect();
    console.log('✅ Prisma connected successfully.');

    const result = await prisma.$queryRaw<Array<{ version: string; now: Date }>>`
      SELECT version(), NOW() as now;
    `;
    const elapsed = Date.now() - start;

    console.log(`✅ Query succeeded in ${elapsed}ms:`);
    console.log('   PostgreSQL version:', result[0]?.version);
    console.log('   Server Timestamp   :', result[0]?.now);
    console.log('🎉 Database connection verified successfully!');
  } catch (error) {
    console.error('❌ Connection failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testConnection();
