#!/usr/bin/env bash
# core/cin7/drain.sh — o supervisor que roda enquanto o dono dorme.
#
# O driver processa UM chunk e sai. Este laço o chama de novo, para sempre,
# e nunca morre por causa de um turno ruim. Todo o estado está no banco:
# matar isto com Ctrl-C e reabrir amanhã continua exatamente de onde parou.
#
#   bash core/cin7/drain.sh                      # ritmo padrão 24/min
#   RATE=20 BUDGET=12 bash core/cin7/drain.sh    # mais devagar
#   JOB=po_detail bash core/cin7/drain.sh        # só um recurso
#
# macOS: envolva em `caffeinate -is` ou o laptop dorme e o dreno para.
#   caffeinate -is bash core/cin7/drain.sh 2>&1 | tee -a /tmp/backfill.log
set -u
cd "$(dirname "$0")/../.."

RATE="${RATE:-24}"
BUDGET="${BUDGET:-12}"
JOB_ARG=""; [ -n "${JOB:-}" ] && JOB_ARG="--job=${JOB}"
FAILS=0

while true; do
  node core/cin7/backfill-driver.js run --budget-min="$BUDGET" --rate="$RATE" $JOB_ARG
  CODE=$?
  case $CODE in
    0) FAILS=0; sleep 10 ;;                       # progrediu, ou nada a fazer
    3) FAILS=$((FAILS+1))                          # falha retentável
       echo "⚠️  turno falhou ($FAILS seguidas) — pausa de $((FAILS*60))s"
       sleep $((FAILS*60))
       if [ $FAILS -ge 5 ]; then
         echo "⛔ 5 falhas seguidas — parando o dreno. Rode: node core/cin7/backfill-driver.js status"
         exit 3
       fi ;;
    4) echo "⛔ chunk BLOCKED — precisa de humano. status:"
       node core/cin7/backfill-driver.js status
       exit 4 ;;
    *) echo "⛔ erro fatal ($CODE) — parando."; exit "$CODE" ;;
  esac
done
