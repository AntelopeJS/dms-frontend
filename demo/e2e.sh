#!/usr/bin/env bash
set -euo pipefail

base_url="${1:?portal or frontend URL required}"
session="dms-migration-parity"

agent-browser --session "$session" open "$base_url/"
agent-browser --session "$session" wait --text "Operations dashboard"
agent-browser --session "$session" wait --text "Monthly revenue"
agent-browser --session "$session" wait --text "Operational"
agent-browser --session "$session" wait --text "Top workflows"

agent-browser --session "$session" eval "async () => { const response = await fetch('/records', { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1', Accept: 'text/html, application/xhtml+xml' } }); if (!response.ok || response.headers.get('x-inertia') !== 'true') throw new Error('Invalid Inertia response'); const page = await response.json(); if (page.props.page.componentName !== 'records') throw new Error('Wrong Inertia component'); }"
agent-browser --session "$session" open "$base_url/records"
agent-browser --session "$session" wait --text "Workflow records"
agent-browser --session "$session" find label "Workflow name" fill "Backup rotation"
agent-browser --session "$session" find role button click --name "Add workflow"
agent-browser --session "$session" wait --text "Backup rotation"

agent-browser --session "$session" open "$base_url/auth/login"
agent-browser --session "$session" wait --text "Connect to your account"
agent-browser --session "$session" find label "Email address" fill "operator@example.test"
agent-browser --session "$session" find label "Password" fill "demo-password"
agent-browser --session "$session" find role button click --name "Login"
agent-browser --session "$session" wait --text "Operations dashboard"
agent-browser --session "$session" eval "async () => { const session = await fetch('/api/_auth/session').then(response => response.json()); if (session.user?.email !== 'operator@example.test') throw new Error('Session cookie missing'); const logout = await fetch('/api/_auth/session', { method: 'DELETE' }); if (!logout.ok) throw new Error('Logout failed'); const cleared = await fetch('/api/_auth/session').then(response => response.json()); if (cleared.user) throw new Error('Session cookie retained'); }"

agent-browser --session "$session" open "$base_url/empty"
agent-browser --session "$session" wait --text "Empty layout"
agent-browser --session "$session" open "$base_url/missing"
agent-browser --session "$session" wait --text "404"
agent-browser --session "$session" eval "() => { const entries = performance.getEntriesByType('resource'); const failed = entries.filter(entry => entry.name.includes('undefined')); if (failed.length) throw new Error('Invalid resource URL'); return { js: entries.filter(entry => entry.name.endsWith('.js')).reduce((sum, entry) => sum + entry.transferSize, 0), css: entries.filter(entry => entry.name.endsWith('.css')).reduce((sum, entry) => sum + entry.transferSize, 0) }; }"
agent-browser --session "$session" close
