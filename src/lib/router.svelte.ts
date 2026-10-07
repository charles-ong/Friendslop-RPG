// Hash routing, since GitHub Pages can't rewrite deep links.
//   #/              home
//   #/join/CODE     invite link
//   #/c/ID          a campaign
export type Route =
  | { name: 'home' }
  | { name: 'join'; code: string }
  | { name: 'campaign'; id: string };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'join' && parts[1]) return { name: 'join', code: parts[1].toUpperCase() };
  if (parts[0] === 'c' && parts[1]) return { name: 'campaign', id: parts[1] };
  return { name: 'home' };
}

export const router = $state({ route: parse(location.hash) });

window.addEventListener('hashchange', () => {
  router.route = parse(location.hash);
});

export function go(path: string) {
  location.hash = path;
}

export function inviteLink(code: string) {
  return `${location.origin}${location.pathname}#/join/${code}`;
}
