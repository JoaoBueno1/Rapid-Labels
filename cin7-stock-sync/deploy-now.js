#!/usr/bin/env node
/**
 * deploy-now.js — Deploy cin7_mirror schema to Supabase
 * 
 * Uso:  node cin7-stock-sync/deploy-now.js SUA_PASSWORD_DO_DB
 * 
 * Para pegar a password:
 *   Supabase Dashboard → Settings → Database → Database Password
 *   Se não lembrar, clica "Reset Database Password", copia a nova
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PROJECT_REF = 'iaqnxamnjftwqdbsnfyl';

async function deploy(password) {
  console.log('🚀 Deploy cin7_mirror schema para Supabase\n');

  // Read SQL
  const sqlPath = path.join(__dirname, 'DEPLOY_ALL.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error('❌ DEPLOY_ALL.sql não encontrado!');
    process.exit(1);
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log(`📄 SQL carregado: ${sql.length} caracteres`);

  // Try multiple connection methods
  const configs = [
    {
      label: 'Direct',
      host: `db.${PROJECT_REF}.supabase.co`,
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    },
    {
      label: 'Pooler session (ap-southeast-2)',
      host: `aws-0-ap-southeast-2.pooler.supabase.com`,
      port: 5432,
      database: 'postgres',
      user: `postgres.${PROJECT_REF}`,
      password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    },
  ];

  let client = null;
  for (const cfg of configs) {
    const c = new Client(cfg);
    try {
      await c.connect();
      const res = await c.query('SELECT 1 as t');
      if (res.rows[0].t === 1) {
        console.log(`✅ Conectado via ${cfg.label}\n`);
        client = c;
        break;
      }
    } catch (err) {
      console.log(`❌ ${cfg.label}: ${err.message.substring(0, 100)}`);
      try { await c.end(); } catch(e) {}
    }
  }

  if (!client) {
    console.error('\n❌ Não consegui conectar. Verifica a password.');
    process.exit(1);
  }

  // Execute SQL
  console.log('📦 Executando DEPLOY_ALL.sql...');
  try {
    await client.query(sql);
    console.log('✅ SQL executado com sucesso!\n');

    // Verify tables
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'cin7_mirror' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    console.log(`📊 Tabelas criadas (${tables.rows.length}):`);
    tables.rows.forEach(r => console.log(`   • ${r.table_name}`));

    // Verify views
    const views = await client.query(`
      SELECT table_name FROM information_schema.views
      WHERE table_schema = 'cin7_mirror'
      ORDER BY table_name
    `);
    console.log(`\n👁️  Views criadas (${views.rows.length}):`);
    views.rows.forEach(r => console.log(`   • ${r.table_name}`));

    // Verify function
    const funcs = await client.query(`
      SELECT routine_name FROM information_schema.routines
      WHERE routine_schema = 'cin7_mirror'
    `);
    console.log(`\n⚡ Functions: ${funcs.rows.map(r => r.routine_name).join(', ') || 'nenhuma'}`);

    // Verify alert rules
    const rules = await client.query('SELECT COUNT(*) as c FROM cin7_mirror.alert_rules');
    console.log(`\n📋 Alert rules: ${rules.rows[0].c}`);

    console.log('\n🎉 Deploy COMPLETO!');
    console.log('\n⚠️  PRÓXIMO PASSO:');
    console.log('   Supabase Dashboard → Settings → API → Schema Settings');
    console.log('   Adiciona "cin7_mirror" na lista de Exposed Schemas\n');
  } catch (err) {
    console.error('\n❌ Erro executando SQL:', err.message);
    if (err.position) {
      const pos = parseInt(err.position);
      const around = sql.substring(Math.max(0, pos - 150), pos + 150);
      console.error('\n📍 Contexto do erro:\n' + around);
    }
  } finally {
    await client.end();
  }
}

// MAIN
const password = process.argv[2];
if (!password) {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Deploy cin7_mirror — Precisa da password do banco        ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║                                                            ║');
  console.log('║  1. Abre: https://supabase.com/dashboard/project/         ║');
  console.log('║           iaqnxamnjftwqdbsnfyl/settings/database          ║');
  console.log('║                                                            ║');
  console.log('║  2. Em "Database Password" clica "Reset Database Password"║');
  console.log('║                                                            ║');
  console.log('║  3. Copia a nova password e roda:                         ║');
  console.log('║                                                            ║');
  console.log('║     node cin7-stock-sync/deploy-now.js SUA_PASSWORD       ║');
  console.log('║                                                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  process.exit(0);
}

deploy(password).catch(console.error);
