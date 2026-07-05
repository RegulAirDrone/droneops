// ─────────────────────────────────────────────────────────────────────────────
// Profenvol — Relais VAC + NOTAM (Cloudflare Worker)
//
// Deux rôles :
//  1) VAC : relayer une carte VAC (PDF) publique du SIA avec les bons en-têtes
//     pour l'afficher DANS l'application.  → appel : <worker>/?url=<PDF du SIA>
//  2) NOTAM : interroger l'API autorouter (données officielles Eurocontrol EAD,
//     couverture européenne dont la France) par code OACI, et renvoyer le JSON
//     avec CORS.  → appel : <worker>/?notam=LFBO
//
// ── COMPTE autorouter (gratuit, EU) ─────────────────────────────────────────
//  a. Crée un compte sur https://www.autorouter.aero (email + mot de passe).
//  b. Ouvre un ticket support (fonction « Support » du site) pour DEMANDER
//     L'ACCÈS API (« please enable API access on my account »). C'est gratuit ;
//     ils l'activent manuellement.
//  c. Dans Cloudflare : ton Worker → Settings → Variables and Secrets → ajoute
//     deux variables (type Secret) :
//        AR_CLIENT_ID      = ton email autorouter
//        AR_CLIENT_SECRET  = ton mot de passe autorouter
//     (Le mot de passe reste secret côté serveur ; il n'apparaît jamais dans l'app.)
//
// ── DÉPLOIEMENT ─────────────────────────────────────────────────────────────
//   1. https://dash.cloudflare.com → Workers & Pages → ton Worker → Edit code.
//   2. Colle TOUT ce fichier → Deploy.
//   3. Ajoute les variables AR_CLIENT_ID / AR_CLIENT_SECRET (voir ci-dessus).
//   4. Dans index.html, la constante VAC_PROXY pointe déjà sur l'URL du Worker.
// ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, CORS),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const params = new URL(request.url).searchParams;

    // ── 1) NOTAM (API autorouter / Eurocontrol EAD) ─────────────────────────
    const icao = params.get('notam');
    if (icao) {
      if (!/^[A-Za-z]{4}$/.test(icao)) return jsonResponse({ error: 'Code OACI invalide' }, 400);
      const id = env && env.AR_CLIENT_ID, secret = env && env.AR_CLIENT_SECRET;
      if (!id || !secret) return jsonResponse({ error: 'Identifiants autorouter non configurés (AR_CLIENT_ID / AR_CLIENT_SECRET dans le Worker).' }, 500);
      try {
        // 1a) obtenir un jeton (client_credentials = email + mot de passe)
        const tok = await fetch('https://api.autorouter.aero/v1.0/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(id) + '&client_secret=' + encodeURIComponent(secret),
        });
        const tj = await tok.json();
        if (!tj || !tj.access_token) {
          return jsonResponse({ error: 'Connexion autorouter refusée : ' + ((tj && (tj.error_description || tj.error)) || 'vérifiez identifiants / accès API activé') }, 502);
        }
        // 1b) récupérer les NOTAM par code OACI (item A)
        const itemas = encodeURIComponent(JSON.stringify([icao.toUpperCase()]));
        const url = 'https://api.autorouter.aero/v1.0/notam?itemas=' + itemas + '&offset=0&limit=60';
        const nr = await fetch(url, { headers: { 'Authorization': 'Bearer ' + tj.access_token, 'Accept': 'application/json' } });
        const body = await nr.text();
        return new Response(body, {
          status: nr.status,
          headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, CORS),
        });
      } catch (e) {
        return jsonResponse({ error: 'NOTAM autorouter injoignable : ' + ((e && e.message) || 'réseau') }, 502);
      }
    }

    // ── 2) VAC (PDF du SIA) ─────────────────────────────────────────────────
    const target = params.get('url');
    if (!target || !/^https:\/\/www\.sia\.aviation-civile\.gouv\.fr\//.test(target)) {
      return new Response('URL non autorisée', { status: 400, headers: CORS });
    }
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/pdf,*/*' },
    });
    const h = new Headers(upstream.headers);
    h.set('Access-Control-Allow-Origin', '*');
    h.delete('X-Frame-Options');
    h.delete('Content-Security-Policy');
    h.delete('Content-Security-Policy-Report-Only');
    h.set('Content-Type', 'application/pdf');
    h.set('Content-Disposition', 'inline');
    h.set('Cache-Control', 'public, max-age=86400');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: h });
  },
};
