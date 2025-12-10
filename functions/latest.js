
/**
 * latest.js - returns events from Gist (same persistence used by fetchNews)
 */
const fetch = require('node-fetch');
const GIST_TOKEN = process.env.GIST_TOKEN;
const GIST_ID = process.env.GIST_ID;
const GIST_API = 'https://api.github.com/gists';

async function loadState(){
  if (!GIST_TOKEN || !GIST_ID) return { events: [] };
  const res = await fetch(`${GIST_API}/${GIST_ID}`, { headers: { Authorization: `token ${GIST_TOKEN}`, 'User-Agent': 'BorderadarBot' }});
  if (!res.ok) return { events: [] };
  const j = await res.json();
  try {
    const file = j.files['borderadar_state.json'];
    const content = JSON.parse(file.content);
    return content;
  } catch(e){
    return { events: [] };
  }
}

exports.handler = async function(){
  try {
    const state = await loadState();
    return { statusCode: 200, body: JSON.stringify({ events: state.events || [] }) };
  } catch(e){
    return { statusCode:500, body: JSON.stringify({ events: [] }) };
  }
};
