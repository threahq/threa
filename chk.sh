cd "$(dirname "$0")/g1-wt/apps/backend"
for f in src/features/activity/service.test.ts src/features/agents/context-bag/resolvers/conversation-resolver.test.ts src/features/agents/context-bag/resolvers/thread-resolver.test.ts src/features/saved-messages/service.test.ts; do
  echo "== $f Visibilities: $(grep -c 'Visibilities' $f)"
done
f=tests/integration/guest-access.test.ts
for w in keysOf "service()" TStale TNThreadMember rootVisibility Visibility usersReadingWithoutMembership StreamMemberRepository; do echo "$w: $(grep -c -F "$w" $f)"; done
