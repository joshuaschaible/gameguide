'use strict';
// Player profile: a name plus an avatar (a built-in emoji avatar or a small
// photo). Avatars travel to the other player over the existing connection, so
// both sides can show Figma-style chips of who's in the session.
//
// Avatar shapes:
//   { kind: 'emoji', value: '🦊', color: '#ff8a00' }
//   { kind: 'photo', data: 'data:image/jpeg;base64,...' }   (96 x 96, a few KB)
(function () {
  const BUILT_IN = [
    { value: '🦊', color: '#ff8a00' }, { value: '🐺', color: '#5b6b8c' },
    { value: '🐼', color: '#3a3f4b' }, { value: '🐸', color: '#3fae5a' },
    { value: '🐙', color: '#d6457a' }, { value: '🦄', color: '#b26bff' },
    { value: '🐲', color: '#2e9e7a' }, { value: '🤖', color: '#3d7bff' },
    { value: '👾', color: '#7c5cff' }, { value: '🐯', color: '#e0a100' },
    { value: '🦉', color: '#8a6a4f' }, { value: '🐧', color: '#2b8bc6' },
  ];
  const PHOTO_SIZE = 96;
  const MAX_PHOTO_CHARS = 40000; // ~30 KB; anything bigger from the network is ignored

  function randomDefault() {
    const a = BUILT_IN[Math.floor(Math.random() * BUILT_IN.length)];
    return { kind: 'emoji', value: a.value, color: a.color };
  }

  // Never trust an avatar that came over the network: only known shapes pass.
  function sanitize(a) {
    if (!a || typeof a !== 'object') return null;
    if (a.kind === 'emoji') {
      const value = String(a.value || '').slice(0, 8);
      const color = /^#[0-9a-fA-F]{6}$/.test(a.color) ? a.color : '#7c5cff';
      return value ? { kind: 'emoji', value, color } : null;
    }
    if (a.kind === 'photo') {
      const data = String(a.data || '');
      if (data.length > MAX_PHOTO_CHARS) return null;
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return null;
      return { kind: 'photo', data };
    }
    return null;
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?').charAt(0) + (parts[1] ? parts[1].charAt(0) : '')).toUpperCase();
  }

  // A round avatar element. size in px.
  function render(avatar, name, size) {
    const a = sanitize(avatar);
    const el = document.createElement('span');
    el.className = 'avatar';
    el.style.width = el.style.height = `${size}px`;
    el.style.fontSize = `${Math.round(size * 0.56)}px`;
    el.title = name || '';
    if (a && a.kind === 'photo') {
      const img = document.createElement('img');
      img.src = a.data;
      img.alt = '';
      el.appendChild(img);
    } else if (a && a.kind === 'emoji') {
      el.style.background = a.color;
      el.textContent = a.value;
    } else {
      el.style.background = '#5b6b8c';
      el.style.fontSize = `${Math.round(size * 0.4)}px`;
      el.textContent = initials(name);
    }
    return el;
  }

  // Shrink any picture to a 96 x 96 centre crop JPEG.
  function photoFromFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('Pick an image file.')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = PHOTO_SIZE;
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - s) / 2;
        const sy = (img.naturalHeight - s) / 2;
        c.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
        URL.revokeObjectURL(url);
        let q = 0.85;
        let data = c.toDataURL('image/jpeg', q);
        while (data.length > MAX_PHOTO_CHARS && q > 0.3) { q -= 0.15; data = c.toDataURL('image/jpeg', q); }
        resolve({ kind: 'photo', data });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that picture.")); };
      img.src = url;
    });
  }

  // Builds a picker into `box`: the built-in avatars + "Upload photo".
  // getCurrent() returns the selected avatar; onChange(avatar) saves it.
  function picker(box, getCurrent, onChange) {
    box.innerHTML = '';
    box.classList.add('avatar-picker');
    const draw = () => {
      const cur = getCurrent();
      box.querySelectorAll('.avatar-option').forEach((b) => {
        const on = cur && ((cur.kind === 'emoji' && b.dataset.value === cur.value) || (cur.kind === 'photo' && b.dataset.photo === '1'));
        b.classList.toggle('active', !!on);
      });
      const photoBtn = box.querySelector('.avatar-option[data-photo="1"]');
      photoBtn.innerHTML = '';
      if (cur && cur.kind === 'photo') photoBtn.appendChild(render(cur, '', 40));
      else photoBtn.textContent = '📷';
    };
    for (const a of BUILT_IN) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar-option';
      b.dataset.value = a.value;
      b.title = 'Use this avatar';
      b.appendChild(render({ kind: 'emoji', value: a.value, color: a.color }, '', 40));
      b.addEventListener('click', () => { onChange({ kind: 'emoji', value: a.value, color: a.color }); draw(); });
      box.appendChild(b);
    }
    const photo = document.createElement('label');
    photo.className = 'avatar-option photo';
    photo.dataset.photo = '1';
    photo.title = 'Upload your own picture';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      try {
        const a = await photoFromFile(input.files && input.files[0]);
        onChange(a);
        draw();
      } catch (e) {
        photo.title = e.message;
      }
      input.value = '';
    });
    box.appendChild(photo);
    box.appendChild(input);
    photo.addEventListener('click', (e) => { e.preventDefault(); input.click(); });
    draw();
  }

  window.Profile = { BUILT_IN, randomDefault, sanitize, render, picker, photoFromFile };
})();
