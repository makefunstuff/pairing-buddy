#!/bin/sh
# A subscription login checked by hand against its provider: you sign in in the browser, into a credential file of
# this run's own (your `pair auth` logins stay untouched), then test/live/login.test.mjs checks that the model answers
# as both roles and that the token renews and is kept. The file is removed at the end.
#
#   test/live/check-login.sh PROVIDER MODEL     e.g. test/live/check-login.sh openai <a model `pair auth models openai` lists>
#
# Each request counts against the plan, and the provider's terms decide whether the plan may be used this way
# (docs/config.md, "Before you use a subscription").
set -eu
if [ $# -ne 2 ]; then
  echo "usage: $0 PROVIDER MODEL (\`pair auth list\` names the providers, \`pair auth models PROVIDER\` their models)" >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/../.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export PAIR_AUTH="$scratch/auth.json"
node "$root/bin/pair.mjs" auth login "$1"
PAIR_LIVE_LOGIN="$1/$2" node --disable-warning=ExperimentalWarning --test "$root/test/live/login.test.mjs"
