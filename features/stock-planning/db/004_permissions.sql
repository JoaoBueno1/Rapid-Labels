-- =====================================================================
-- Stock Planning · 004 · USUÁRIOS E PERMISSÕES
-- ---------------------------------------------------------------------
-- Hoje o app inteiro usa um PIN 4209 compartilhado e não existe tabela de
-- usuários. Para 50–80 pessoas isso não escala nem é auditável.
--
-- Este arquivo CRIA a estrutura mas NÃO liga o gate. Na V1 o módulo só
-- identifica quem está editando (para o audit_log). O bloqueio por papel
-- entra na fase 8, quando houver login de verdade — e aí o schema já está
-- no lugar, sem migração nova.
-- =====================================================================

CREATE TABLE IF NOT EXISTS rapid_inv.app_users (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT UNIQUE,
  name         TEXT NOT NULL,
  initials     TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rapid_inv.app_roles (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INT DEFAULT 100
);

INSERT INTO rapid_inv.app_roles (code, name, description, sort_order) VALUES
  ('VIEWER',    'Viewer',      'Lê tudo, não edita nada',                        10),
  ('SALES',     'Sales / CS',  'Cria e edita projetos e draws dos próprios SOs', 20),
  ('WAREHOUSE', 'Warehouse',   'Marca held, packed e picked',                    30),
  ('PLANNER',   'Planner',     'Parâmetros de planejamento e conclusão de projeto', 40),
  ('PURCHASING','Purchasing',  'Ordens de compra e datas de chegada',            50),
  ('ADMIN',     'Admin',       'Tudo, incluindo gestão de usuários',             90)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS rapid_inv.role_permissions (
  role_code  TEXT NOT NULL REFERENCES rapid_inv.app_roles(code) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_code, permission)
);

-- Matriz inicial. Ler é implícito para todo mundo autenticado; aqui só escrita.
INSERT INTO rapid_inv.role_permissions (role_code, permission) VALUES
  ('SALES','projects.create'), ('SALES','projects.edit'), ('SALES','lines.edit'),
  ('SALES','draws.edit'),      ('SALES','draws.split'),

  ('WAREHOUSE','lines.edit_fulfilment'),   -- qty_held, date_packed
  ('WAREHOUSE','draws.mark_picked'),

  ('PLANNER','projects.create'), ('PLANNER','projects.edit'), ('PLANNER','projects.complete'),
  ('PLANNER','lines.edit'),      ('PLANNER','draws.edit'),    ('PLANNER','draws.split'),
  ('PLANNER','planning.edit_wkavg'), ('PLANNER','planning.edit_target'),
  ('PLANNER','planning.edit_seasonal'), ('PLANNER','planning.roll_week'),
  ('PLANNER','po.edit'),

  ('PURCHASING','po.create'), ('PURCHASING','po.edit'), ('PURCHASING','po.edit_dates'),

  ('ADMIN','*')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS rapid_inv.user_roles (
  user_id   BIGINT NOT NULL REFERENCES rapid_inv.app_users(id) ON DELETE CASCADE,
  role_code TEXT   NOT NULL REFERENCES rapid_inv.app_roles(code) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_code)
);

-- Resolve as permissões efetivas de um usuário. ADMIN com '*' cobre tudo.
CREATE OR REPLACE VIEW rapid_inv.v_sp_user_permissions AS
SELECT u.id AS user_id, u.email, u.name, ur.role_code, rp.permission
FROM rapid_inv.app_users u
JOIN rapid_inv.user_roles       ur ON ur.user_id  = u.id
JOIN rapid_inv.role_permissions rp ON rp.role_code = ur.role_code
WHERE u.is_active;

CREATE OR REPLACE FUNCTION rapid_inv.sp_can(p_email TEXT, p_permission TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM rapid_inv.v_sp_user_permissions
    WHERE email = p_email AND permission IN (p_permission, '*')
  );
$$;

DO $$ BEGIN RAISE NOTICE '004_permissions: estrutura criada (gate desligado na V1)'; END $$;
