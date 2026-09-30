// Vercel provides the visitor's ISO country code from the connecting IP.
export function languageForCountry(country) {
  return ({ TR: 'tr', FR: 'fr', ES: 'es', DE: 'de' })[String(country || '').trim().toUpperCase()] || 'en';
}

export function GET(request) {
  const language = languageForCountry(request.headers.get('x-vercel-ip-country'));
  return Response.json({ language }, {
    headers: { 'Cache-Control': 'private, no-store', Vary: 'x-vercel-ip-country' }
  });
}
