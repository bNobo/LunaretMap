// Enregistrement du service worker pour la mise en cache
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js');
}

// Gestion du mode plein écran
function toggleFullScreen() {
    const container = document.getElementById('map-container');

    if (!document.fullscreenElement) {
        // Passer en plein écran
        if (container.requestFullscreen) {
            container.requestFullscreen();
        } else if (container.webkitRequestFullscreen) {
            container.webkitRequestFullscreen();
        } else if (container.msRequestFullscreen) {
            container.msRequestFullscreen();
        }
    } else {
        // Quitter le plein écran
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    }
}

// --- Affichage du point GPS sur la carte ---
// Coordonnées GPS des coins de la carte (à ajuster selon la carte réelle)

const MAP_ORIENTATION = -11.8; // Orientation de la carte en degrés (positive = vers la droite). Il s'agit de l'angle entre le nord géographique et le haut de la carte affichée.
const gpsTopLeft = { lat: 43.64526958682147, lng: 3.8610944495057855 };
const gpsBottomRight = { lat: 43.63856388483909, lng: 3.894421125886565 };
const gpsTopRight = { lat: 43.64981194623201, lng: 3.8910884500021616 };
const gpsBottomLeft = { lat: 43.63402734120482, lng: 3.8642750642904535 };

// Nouvelle fonction de conversion GPS -> pixel utilisant les 4 coins (transformation bilinéaire)
function gpsToPixel(lat, lng, imgWidth, imgHeight) {
    // Normalisation des coordonnées GPS dans le quadrilatère
    // On résout :
    //   gps = (1-u)*(1-v)*topLeft + u*(1-v)*topRight + (1-u)*v*bottomLeft + u*v*bottomRight
    //   pour (u,v) dans [0,1]
    // Méthode numérique simple (itérative)
    function gpsQuadToXY(lat, lng) {
        const EPS = 1e-6;
        let u = 0.5, v = 0.5;
        for (let iter = 0; iter < 10; iter++) {
            // Interpolation bilinéaire
            const lat_ = (1 - u) * (1 - v) * gpsTopLeft.lat + u * (1 - v) * gpsTopRight.lat + (1 - u) * v * gpsBottomLeft.lat + u * v * gpsBottomRight.lat;
            const lng_ = (1 - u) * (1 - v) * gpsTopLeft.lng + u * (1 - v) * gpsTopRight.lng + (1 - u) * v * gpsBottomLeft.lng + u * v * gpsBottomRight.lng;
            // Jacobien
            const dlat_du = (1 - v) * (gpsTopRight.lat - gpsTopLeft.lat) + v * (gpsBottomRight.lat - gpsBottomLeft.lat);
            const dlat_dv = (1 - u) * (gpsBottomLeft.lat - gpsTopLeft.lat) + u * (gpsBottomRight.lat - gpsTopRight.lat);
            const dlng_du = (1 - v) * (gpsTopRight.lng - gpsTopLeft.lng) + v * (gpsBottomRight.lng - gpsBottomLeft.lng);
            const dlng_dv = (1 - u) * (gpsBottomLeft.lng - gpsTopLeft.lng) + u * (gpsBottomRight.lng - gpsTopRight.lng);
            // Système linéaire
            const det = dlat_du * dlng_dv - dlat_dv * dlng_du;
            if (Math.abs(det) < 1e-12) break;
            const du = ((lat - lat_) * dlng_dv - (lng - lng_) * dlat_dv) / det;
            const dv = ((lng - lng_) * dlat_du - (lat - lat_) * dlng_du) / det;
            u += du;
            v += dv;
            if (Math.abs(du) < EPS && Math.abs(dv) < EPS) break;
            // Clamp
            u = Math.max(0, Math.min(1, u));
            v = Math.max(0, Math.min(1, v));
        }
        return { u, v };
    }
    const { u, v } = gpsQuadToXY(lat, lng);
    // u,v dans [0,1] -> pixel
    return { x: u * imgWidth, y: v * imgHeight };
}

let lastGpsPosition = null;
let gpsTrail = []; // Stockage des positions GPS pour la trace
let canvas = null;
let ctx = null;
let gpsSignalLost = false;

// --- Orientation du téléphone (boussole) ---
let deviceHeading = 0; // 0 = nord
let hasDeviceOrientation = false;

if (window.DeviceOrientationEvent) {
    window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
}

function handleDeviceOrientation(event) {
    // Privilégier absolute, pas de fallback sur alpha
    let heading = null;
    if (typeof event.webkitCompassHeading === 'number') {
        // iOS
        heading = event.webkitCompassHeading;
    } else if (typeof event.absolute === 'boolean' && event.absolute && typeof event.alpha === 'number') {
        // Android/Chrome
        heading = 360 - event.alpha;
    }
    if (heading !== null && !isNaN(heading)) {
        // Correction selon l'orientation de l'écran
        let orientation = 0;
        if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
            orientation = window.screen.orientation.angle;
        } else if (typeof window.orientation === 'number') {
            orientation = window.orientation;
        }
        // En paysage, il faut corriger la boussole
        // Portrait primaire: 0, paysage primaire: 90, paysage secondaire: -90 ou 270, portrait secondaire: 180
        // On ajoute l'angle d'orientation de l'écran
        let correctedHeading = (heading + orientation);
        correctedHeading = (correctedHeading + 360) % 360;
        deviceHeading = correctedHeading;
        hasDeviceOrientation = true;
    }
}

// --- Hors zone ---
function isPointInQuad(lat, lng) {
    // Utilise la même méthode que gpsToPixel pour obtenir (u,v), mais sans clamp dans la boucle !
    function gpsQuadToUV(lat, lng) {
        const EPS = 1e-6;
        let u = 0.5, v = 0.5;
        for (let iter = 0; iter < 10; iter++) {
            const lat_ = (1 - u) * (1 - v) * gpsTopLeft.lat + u * (1 - v) * gpsTopRight.lat + (1 - u) * v * gpsBottomLeft.lat + u * v * gpsBottomRight.lat;
            const lng_ = (1 - u) * (1 - v) * gpsTopLeft.lng + u * (1 - v) * gpsTopRight.lng + (1 - u) * v * gpsBottomLeft.lng + u * v * gpsBottomRight.lng;
            const dlat_du = (1 - v) * (gpsTopRight.lat - gpsTopLeft.lat) + v * (gpsBottomRight.lat - gpsBottomLeft.lat);
            const dlat_dv = (1 - u) * (gpsBottomLeft.lat - gpsTopLeft.lat) + u * (gpsBottomRight.lat - gpsTopRight.lat);
            const dlng_du = (1 - v) * (gpsTopRight.lng - gpsTopLeft.lng) + v * (gpsBottomRight.lng - gpsBottomLeft.lng);
            const dlng_dv = (1 - u) * (gpsBottomLeft.lng - gpsTopLeft.lng) + u * (gpsBottomRight.lng - gpsTopRight.lng);
            const det = dlat_du * dlng_dv - dlat_dv * dlng_du;
            if (Math.abs(det) < 1e-12) break;
            const du = ((lat - lat_) * dlng_dv - (lng - lng_) * dlat_dv) / det;
            const dv = ((lng - lng_) * dlat_du - (lat - lat_) * dlng_du) / det;
            u += du;
            v += dv;
            if (Math.abs(du) < EPS && Math.abs(dv) < EPS) break;
            // NE PAS CLAMPER u et v ici !
        }
        return { u, v };
    }
    const { u, v } = gpsQuadToUV(lat, lng);
    // On considère "dans la zone" si u et v sont dans [0,1] (avec une petite tolérance)
    return u >= -0.02 && u <= 1.02 && v >= -0.02 && v <= 1.02;
}

function showOutOfBoundsPanel(show, angleToMapCenter = 0) {
    const panel = document.getElementById('out-of-bounds-panel');
    if (!panel) return;
    if (show) {
        panel.style.display = 'block';
        // Tourner la flèche en tenant compte de l'orientation du téléphone
        const arrow = document.getElementById('direction-arrow');
        if (arrow) {
            let correctedAngle = angleToMapCenter;
            if (hasDeviceOrientation) {
                correctedAngle -= deviceHeading;
            }
            else {
                correctedAngle -= lastGpsPosition.heading;
            }
            // Normaliser l'angle
            correctedAngle = ((correctedAngle % 360) + 360) % 360;
            arrow.style.transform = `rotate(${correctedAngle}deg)`;
        }
    } else {
        panel.style.display = 'none';
    }
}

function computeAngleToCenter(lat, lng) {
    // Centre du parc (moyenne des coins)
    const centerLat = (gpsTopLeft.lat + gpsTopRight.lat + gpsBottomLeft.lat + gpsBottomRight.lat) / 4;
    const centerLng = (gpsTopLeft.lng + gpsTopRight.lng + gpsBottomLeft.lng + gpsBottomRight.lng) / 4;
    // Angle du point vers le centre (en degrés, 0 = nord)
    const dLat = centerLat - lat;
    const dLng = centerLng - lng;
    const angleRad = Math.atan2(dLng, dLat); // y = nord, x = est
    let angleDeg = angleRad * 180 / Math.PI;
    angleDeg = (angleDeg + 360) % 360;
    // Adapter pour que 0° = haut (nord)
    return angleDeg;
}

// Fonction pour détecter les changements de hauteur du viewport et mettre à jour l'affichage
function handleViewportResize() {
    const currentHeight = window.innerHeight;
    //console.log(`Viewport height changed to ${currentHeight}`);
    lastViewportHeight = currentHeight;

    // Laisser un peu de temps au navigateur pour appliquer les changements CSS
    requestAnimationFrame(() => {
        if (lastGpsPosition) {
            showGpsDot();
        }
    });
}

// Historique des directions pour le calcul de la moyenne mobile
const headingHistory = [];
const MAX_HEADING_HISTORY = 5; // Nombre de valeurs à conserver pour la moyenne

// Fonction pour calculer la moyenne des angles en degrés
function calculateAverageHeading(headings) {
    if (headings.length === 0) return null;

    // Convertir en coordonnées cartésiennes pour gérer correctement la moyenne circulaire
    let sumX = 0;
    let sumY = 0;

    for (const heading of headings) {
        const rad = heading * Math.PI / 180;
        sumX += Math.cos(rad);
        sumY += Math.sin(rad);
    }

    // Calculer l'angle moyen et convertir en degrés
    const avgRad = Math.atan2(sumY, sumX);
    return ((avgRad * 180 / Math.PI) + 360) % 360;
}

// Fonction utilitaire (half versed sine) pour calculer la distance entre deux points GPS (en mètres).
// Calcule la distance à vol d'oiseau (distance orthodromique) entre deux points donnés par leurs coordonnées GPS (latitude/longitude), en tenant compte de la courbure de la Terre.
function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Rayon de la Terre en mètres
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function showGpsDot() {
    const lat = lastGpsPosition.lat;
    const lng = lastGpsPosition.lng;
    const heading = lastGpsPosition.heading;

    // Vérifier si hors zone
    const inZone = isPointInQuad(lat, lng);
    if (!inZone) {
        // Calculer l'angle vers le centre
        const angle = computeAngleToCenter(lat, lng);
        console.log(`Hors zone : (${lat}, ${lng}) - Angle vers le centre : ${angle}°`);
        showOutOfBoundsPanel(true, angle);
        // Ne pas dessiner le point rouge ni la trace
        // Effacer le canvas
        if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    } else {
        showOutOfBoundsPanel(false);
    }

    const DISTANCE_MIN = 10;   // mètres (éviter les doublons trop proches)
    const DISTANCE_MAX = 2000;  // mètres (filtrer les sauts GPS)
    const DISTANCE_THRESHOLD = 80; // mètres (distance minimale pour ajouter un tracé plein)

    let addPoint = false;
    if (gpsTrail.length === 0) {
        addPoint = true;
    } else {
        const last = gpsTrail[gpsTrail.length - 1];
        const dist = haversine(last.lat, last.lng, lat, lng);
        if (dist > DISTANCE_MIN && dist < DISTANCE_MAX) {
            addPoint = true;
        }
    }
    if (addPoint) {
        gpsTrail.push({ lat, lng, timestamp: Date.now() });
    }

    const img = document.getElementById('carte');

    // Attendre que l'image soit chargée
    if (!img.complete) {
        img.onload = () => showGpsDot();
        return;
    }

    const container = document.getElementById('map-container');
    const rect = container.getBoundingClientRect();

    // Calculer le ratio de l'image et du conteneur
    const naturalRatio = img.naturalWidth / img.naturalHeight;
    const containerHeight = rect.height;
    const containerRatio = rect.width / containerHeight;
    let displayWidth, displayHeight, offsetX, offsetY;

    if (containerRatio > naturalRatio) {
        // marges à gauche/droite
        displayHeight = containerHeight;
        displayWidth = containerHeight * naturalRatio;
        offsetX = rect.left + (rect.width - displayWidth) / 2;
        offsetY = rect.top;
    } else {
        // marges en haut/bas
        displayWidth = rect.width;
        displayHeight = rect.width / naturalRatio;
        offsetX = rect.left;
        offsetY = rect.top + (containerHeight - displayHeight) / 2;
    }


    // Initialiser le canvas si nécessaire
    if (!canvas) {
        canvas = document.getElementById('trail-canvas');
        ctx = canvas.getContext('2d');
    }

    // Dimensionner le canvas pour qu'il corresponde exactement à la zone de l'image
    const devicePixelRatio = window.devicePixelRatio || 1;
    //console.log(`Device Pixel Ratio: ${devicePixelRatio}`);
    canvas.width = displayWidth * devicePixelRatio;
    canvas.height = displayHeight * devicePixelRatio;
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';
    canvas.style.left = offsetX + 'px';
    canvas.style.top = offsetY + 'px';

    // Appliquer le scaling pour la densité de pixels
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    // Effacer le canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Dessiner la trace
    if (gpsTrail.length > 1) {
        // Configuration pour des lignes nettes
        ctx.strokeStyle = '#007bff';
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        ctx.beginPath();
        // Dessiner chaque étape de la trace
        for (let i = 0; i < gpsTrail.length; i++) {
            const pos = gpsTrail[i];
            const px = gpsToPixel(pos.lat, pos.lng, displayWidth, displayHeight);
            // Les coordonnées sont maintenant relatives au canvas (plus besoin d'offset)
            const x = px.x;
            const y = px.y;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                const prev = gpsTrail[i - 1];
                const dist = haversine(prev.lat, prev.lng, pos.lat, pos.lng);
                if (dist > DISTANCE_THRESHOLD) {
                    // Ligne en pointillés
                    ctx.setLineDash([1, 4]);
                } else {
                    ctx.setLineDash([]);
                }
                ctx.lineTo(x, y);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x, y);
            }
        }
        ctx.setLineDash([]); // Réinitialiser
        ctx.stroke();

        // Point vert au départ
        const pos = gpsTrail[0];
        const px = gpsToPixel(pos.lat, pos.lng, displayWidth, displayHeight);
        // Les coordonnées sont maintenant relatives au canvas (plus besoin d'offset)
        const x = px.x;
        const y = px.y;

        ctx.fillStyle = '#28a745';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, 2 * Math.PI);
        ctx.fill();

        // Bordure blanche pour contraste
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, 2 * Math.PI);
        ctx.stroke();
    }

    if (gpsSignalLost) {
        // Dessiner un cercle avec un point d'interrogation à la dernière position connue
        const px = gpsToPixel(lat, lng, displayWidth, displayHeight);
        const radius = 14 / devicePixelRatio;

        ctx.save();
        ctx.beginPath();
        ctx.arc(px.x, px.y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffe200'; // Jaune panneau Attention
        ctx.strokeStyle = '#b88c4a'; // Marron clair
        ctx.lineWidth = 3 / devicePixelRatio;
        ctx.fill();
        ctx.stroke();

        // Dessiner le point d'interrogation
        ctx.font = `${Math.round(radius * 1.2)}px Arial`;
        ctx.fillStyle = '#5c2d13'; // Marron titre principal
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', px.x, px.y);

        ctx.restore();
        return;
    }

    // Calculer la position du point GPS actuel dans l'image affichée
    const px = gpsToPixel(lat, lng, displayWidth, displayHeight);

    // Animation de pulsation (effet "bulle") autour du point rouge
    // On utilise requestAnimationFrame pour animer le halo

    // Animation de pulsation (effet "bulle") autour du point rouge, toujours dans le même sens
    if (!window._gpsPulseStart) window._gpsPulseStart = performance.now();
    const t = performance.now() - window._gpsPulseStart;
    const pulseDuration = 1500; // ms pour un cycle complet
    const pauseDuration = 1000;  // ms de pause entre deux pulsations
    const totalDuration = pulseDuration + pauseDuration;
    const cycle = t % totalDuration;
    const radius = 10 / devicePixelRatio; // Rayon du cercle
    let haloRadius = radius;
    let haloAlpha = 0;

    if (cycle < pulseDuration) {
        // Phase de pulsation
        const phase = cycle / pulseDuration; // 0 à 1
        haloRadius = radius + 10 * phase;
        haloAlpha = 0.6 * (1 - phase);
        if (haloAlpha > 0.0) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(px.x, px.y, haloRadius, 0, 2 * Math.PI);
            ctx.fillStyle = `rgba(255,0,0,${haloAlpha})`;
            ctx.fill();
            ctx.restore();
        }
    }
    // Pas besoin de réinitialiser window._gpsPulseStart, le modulo gère le cycle

    // Point rouge classique
    ctx.save();
    ctx.beginPath();
    ctx.arc(px.x, px.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = 'red';
    ctx.shadowColor = 'rgba(204, 0, 0, 0.6)';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.restore();

    // Bordure blanche
    ctx.save();
    ctx.beginPath();
    ctx.arc(px.x, px.y, radius, 0, 2 * Math.PI);
    ctx.lineWidth = 4 / devicePixelRatio;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();

    // Relance l'animation à chaque frame
    if (!window._gpsPulseAnim) {
        window._gpsPulseAnim = true;
        function animatePulse() {
            window._gpsPulseAnim = false;
            if (lastGpsPosition) {
                showGpsDot();
            }
        }
        requestAnimationFrame(animatePulse);
    }

    // Décommenter pour tester la fonction de dessin du cône de direction vers le nord
    //drawDirectionCone(ctx, px.x, px.y, 0.0);

    // Mettre à jour l'historique des directions si on a une nouvelle valeur valide
    if (heading !== null && !isNaN(heading)) {
        headingHistory.push(heading);
        // Garder seulement les N dernières valeurs
        if (headingHistory.length > MAX_HEADING_HISTORY) {
            headingHistory.shift();
        }
    }

    if (headingHistory.length === MAX_HEADING_HISTORY) {
        // Calculer la direction moyenne
        const avgHeading = calculateAverageHeading(headingHistory);

        // Dessiner le cône de direction avec la direction moyenne
        drawDirectionCone(ctx, px.x, px.y, avgHeading);
    }
}

// Fonction pour dessiner le cône de direction
function drawDirectionCone(ctx, x, y, heading) {
    const coneLength = 15 / devicePixelRatio; // Longueur du cône réduite pour rester dans le cercle
    const coneWidth = 10 / devicePixelRatio;   // Largeur de la base du cône réduite

    // Convertir l'angle en radians (heading est en degrés, 0° = Nord)
    // On soustrait 90° pour que 0° pointe vers le haut (Nord)
    // Et on soustrait la rotation de la carte pour compenser
    const angleRad = (heading - 90 - MAP_ORIENTATION) * Math.PI / 180;

    // Point de la pointe du cône
    const tipX = x + Math.cos(angleRad) * coneLength;
    const tipY = y + Math.sin(angleRad) * coneLength;

    // Calculer les points de la base du triangle (perpendiculaires à la direction)
    const perpAngle = angleRad + Math.PI / 2; // Angle perpendiculaire

    const base1X = x + Math.cos(perpAngle) * (coneWidth / 2);
    const base1Y = y + Math.sin(perpAngle) * (coneWidth / 2);
    const base2X = x - Math.cos(perpAngle) * (coneWidth / 2);
    const base2Y = y - Math.sin(perpAngle) * (coneWidth / 2);

    //console.log(`Drawing cone at (${x}, ${y}) with heading ${heading}°`);
    //console.log(`Tip: (${tipX}, ${tipY}), Base1: (${base1X}, ${base1Y}), Base2: (${base2X}, ${base2Y})`);

    // Dessiner le cône
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'; // Blanc semi-transparent pour contraster avec le rouge
    ctx.strokeStyle = '#000000'; // Bordure noire pour meilleur contraste
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(base1X, base1Y);
    ctx.lineTo(base2X, base2Y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

let lastPositionTimestamp = null;
const GPS_TIMEOUT = 10000; // 10 secondes sans nouvelle position = signal perdu
let gpsWaitingNotificationUserHidden = false;

if (navigator.geolocation) {
    navigator.geolocation.watchPosition(
        pos => {
            const { latitude, longitude } = pos.coords;
            const heading = pos.coords.heading; // Récupérer la direction
            lastPositionTimestamp = Date.now();
            
            lastGpsPosition = {
                lat: latitude,
                lng: longitude,
                heading: hasDeviceOrientation ? deviceHeading : heading
            };
            gpsWaitingNotificationUserHidden = false; // Réinitialiser le flag si on reçoit une position
            gpsSignalLost = false;
            showGpsDot();
        },
        err => {
            console.log(`Erreur de géolocalisation : ${err.code} - ${err.message}`);
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
    );
} else {
    console.log("La géolocalisation n'est pas supportée par ce navigateur.");
}

setInterval(() => {
    if (gpsWaitingNotificationUserHidden) return; // Ne pas afficher si l'utilisateur a masqué la notification
    if (!lastPositionTimestamp || Date.now() - lastPositionTimestamp > GPS_TIMEOUT) {
        gpsSignalLost = true;
        showGpsWaitingNotification();
    } else {
        gpsSignalLost = false;
        hideGpsWaitingNotification();
    }
}, 1000);

function showGpsWaitingNotification() {
    document.getElementById('gps-waiting-notification').classList.add('visible');
}

function hideGpsWaitingNotification() {
    document.getElementById('gps-waiting-notification').classList.remove('visible');
}

// Gérer les changements de taille et d'orientation avec ResizeObserver
const resizeObserver = new ResizeObserver((entries) => {
    requestAnimationFrame(handleViewportResize);
});

// Observer les changements de taille sur la fenêtre
resizeObserver.observe(document.documentElement);

// Enregistrement des événements ici pour s'assurer que le DOM est prêt
document.addEventListener('DOMContentLoaded', function () {
    // Gérer les changements de visibilité du document
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && lastGpsPosition) {
            // Recalculer la position après un court délai quand la page redevient visible
            setTimeout(() => {
                showGpsDot();
            }, 300);
        }
    });

    // Gestionnaire d'événements pour le bouton de masquage de la notification GPS
    document.getElementById('gps-notif-hide').onclick = function () {
        hideGpsWaitingNotification();
        gpsWaitingNotificationUserHidden = true;
    };

    // Gestionnaire d'événements pour le bouton plein écran
    document.getElementById('fullscreen-btn').addEventListener('click', toggleFullScreen);

    // Gestionnaire d'événements pour le bouton de réduction du panneau "Hors zone"
    const outPanel = document.getElementById('out-of-bounds-panel');
    const hideBtn = document.getElementById('out-of-bounds-hide-btn');

    if (hideBtn && outPanel) {
        hideBtn.onclick = function () {
            outPanel.classList.add('reduced');
            // Afficher le bouton "restaurer"
            if (!document.getElementById('out-of-bounds-restore-btn')) {
                const restoreBtn = document.createElement('button');
                restoreBtn.className = 'panel-restore-btn';
                restoreBtn.id = 'out-of-bounds-restore-btn';
                restoreBtn.title = "Agrandir";
                restoreBtn.ariaLabel = "Agrandir";
                restoreBtn.innerHTML = `
<svg width="38" height="38" viewBox="0 0 24 24">
  <path fill="#000000" d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"/>
</svg>`;
                // Ajoute le bouton avant la flèche
                const arrowContainer = outPanel.querySelector('.arrow-container');
                arrowContainer.insertBefore(restoreBtn, arrowContainer.firstChild);
                restoreBtn.onclick = function () {
                    outPanel.classList.remove('reduced');
                    restoreBtn.remove();
                };
            }
        };
    }

});