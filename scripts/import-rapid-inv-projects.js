#!/usr/bin/env node
/**
 * Importa projetos abertos (aba "Project" do Excel) para rapid_inv.project_lines.
 *
 * SEGURO POR PADRÃO: sem --write ele só faz dry-run (não grava nada).
 *   node scripts/import-rapid-inv-projects.js              # dry-run (conta/valida)
 *   node scripts/import-rapid-inv-projects.js --write      # grava de verdade
 *   node scripts/import-rapid-inv-projects.js --write --all # inclui já-faturadas
 *
 * Lê o JSON gerado por /tmp/xl/extract_projects.js. Usa a chave ANON (que tem
 * GRANT no schema rapid_inv). Não altera nenhuma outra tabela/página.
 */
const fs = require('fs');
const path = require('path');
const REPO = '/Users/joaomarcos/Desktop/untitled folder/LabelsApp_Final';
require(path.join(REPO, 'node_modules', 'dotenv')).config({ path: path.join(REPO, '.env') });
const { createClient } = require(path.join(REPO, 'node_modules', '@supabase/supabase-js'));

const WRITE = process.argv.includes('--write');
const ALL   = process.argv.includes('--all');
const SRC = ALL ? '/tmp/xl/project_import_all.json' : '/tmp/xl/project_import_pending.json';

const url = process.env.SUPABASE_URL;
const cfg = fs.readFileSync(path.join(REPO, 'supabase-config.js'), 'utf8');
const key = (cfg.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/) || [])[1];
if (!url || !key) { console.error('ENV faltando'); process.exit(1); }
const ri = createClient(url, key, { auth: { persistSession: false } }).schema('rapid_inv');

(async () => {
  const allRows = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  // date_opened é NOT NULL. No bulk-insert o PostgREST usa a união das chaves,
  // então omitir não basta -> preenche com a data de hoje (= comportamento do DEFAULT).
  const today = new Date().toISOString().slice(0, 10);
  allRows.forEach(r => { if (!r.date_opened) r.date_opened = today; });

  // suporte a fatia (--offset N --count M) p/ reimportar só parte sem duplicar
  const argN = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? Number(process.argv[i+1]) : null; };
  const offset = argN('--offset') || 0;
  const sliceCount = argN('--count');
  const rows = (offset || sliceCount != null) ? allRows.slice(offset, sliceCount != null ? offset + sliceCount : undefined) : allRows;

  console.log(`Fonte: ${SRC}`);
  console.log(`Total no arquivo: ${allRows.length} | Importando: ${rows.length}` + (offset||sliceCount!=null ? ` (fatia offset=${offset} count=${sliceCount})` : ''));

  // Guarda anti-duplicação: se já houver dados, não importa sem --force
  const { count, error: cErr } = await ri.from('project_lines').select('id', { count: 'exact', head: true });
  if (cErr) { console.error('Erro ao checar count:', cErr.message); process.exit(1); }
  console.log(`project_lines hoje: ${count} linhas`);
  if (count > 0 && !process.argv.includes('--force')) {
    console.error('⚠️  Já existem linhas. Use --force para importar mesmo assim (pode duplicar).');
    process.exit(1);
  }

  if (!WRITE) {
    console.log('\nDRY-RUN (sem --write). Nada foi gravado.');
    console.log('Amostra (1):', JSON.stringify(rows[0]));
    return;
  }

  // marca o usuário do audit
  try { await ri.rpc('set_audit_user', { p_email: 'excel-import', p_pin: '4209' }); } catch (e) {}

  const BATCH = 500;
  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await ri.from('project_lines').insert(chunk);
    if (error) { fail += chunk.length; console.error(`Batch ${i}-${i+chunk.length}: ❌ ${error.message}`); }
    else { ok += chunk.length; console.log(`Batch ${i}-${i+chunk.length}: ✅ (${ok} total)`); }
  }
  console.log(`\nConcluído. Inseridas: ${ok} | Falhas: ${fail}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
