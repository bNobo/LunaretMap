// Fonction pour mettre à jour la hauteur du viewport en CSS
function setViewportHeight() {
    // Obtenir la hauteur réelle du viewport
    const vh = window.innerHeight * 0.01;
    // Définir la variable CSS personnalisée
    document.documentElement.style.setProperty('--vh', `${vh}px`);
}

// Exécuter au chargement
setViewportHeight();

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

// Gestionnaire d'événements pour le bouton plein écran
document.getElementById('fullscreen-btn').addEventListener('click', toggleFullScreen);

// Gestionnaire pour les changements de plein écran
document.addEventListener('fullscreenchange', () => {
    // Forcer un redimensionnement après un court délai pour laisser le temps au navigateur
    // de mettre à jour les dimensions de l'écran
    setTimeout(() => {
        handleViewportResize();
        if (lastGpsPosition) {
            // Si nous avons une position GPS, mettre à jour l'affichage du point
            showGpsDot(lastGpsPosition.lat, lastGpsPosition.lng, lastGpsPosition.heading);
        }
    }, 100);
});

// --- Affichage du point GPS sur la carte ---
// Coordonnées GPS des coins de la carte (à ajuster selon la carte réelle)

const MAP_ROTATION = 11.8; // Rotation de la carte en degrés (positive = vers la droite)
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
let lastViewportHeight = window.innerHeight; // Stocker la dernière hauteur connue

// Fonction pour détecter les changements de hauteur du viewport et mettre à jour l'affichage
function handleViewportResize() {
    // Mettre à jour la hauteur du viewport
    setViewportHeight();
    
    const currentHeight = window.innerHeight;
    if (currentHeight !== lastViewportHeight) {
        console.log(`Viewport height changed from ${lastViewportHeight} to ${currentHeight}`);
        lastViewportHeight = currentHeight;
        
        // Laisser un peu de temps au navigateur pour appliquer les changements CSS
        requestAnimationFrame(() => {
            if (lastGpsPosition) {
                showGpsDot(lastGpsPosition.lat, lastGpsPosition.lng, lastGpsPosition.heading);
            }
        });
    }
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

function showGpsDot(lat, lng, heading = null) {
    lastGpsPosition = { lat, lng, heading };

    // Ajouter la nouvelle position à la trace (éviter les doublons trop proches)
    if (gpsTrail.length === 0 ||
        Math.abs(gpsTrail[gpsTrail.length - 1].lat - lat) > 0.0005 ||
        Math.abs(gpsTrail[gpsTrail.length - 1].lng - lng) > 0.0005) {
        gpsTrail.push({ lat, lng, timestamp: Date.now() });
    }

    const img = document.getElementById('carte');

    // Attendre que l'image soit chargée
    if (!img.complete) {
        img.onload = () => showGpsDot(lat, lng);
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
    console.log(`Device Pixel Ratio: ${devicePixelRatio}`);
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
                ctx.lineTo(x, y);
            }
        }
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

    // Calculer la position du point GPS actuel dans l'image affichée
    const px = gpsToPixel(lat, lng, displayWidth, displayHeight);

    // Dessiner d'abord un cercle rouge sur le canvas
    const radius = 10 / devicePixelRatio; // Rayon du cercle

    ctx.fillStyle = 'red';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 6 / devicePixelRatio;
    ctx.beginPath();
    ctx.arc(px.x, px.y, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    // Ajouter une ombre pour l'effet visuel
    ctx.shadowColor = 'rgba(204, 0, 0, 0.6)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.beginPath();
    ctx.arc(px.x, px.y, radius, 0, 2 * Math.PI);
    ctx.fill();

    // Réinitialiser l'ombre
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    //Forcer la direction à un angle fixe au besoin pour les tests
    //heading = 0.0;

    // headingHistory.push(30.0); // Ajouter une valeur fixe pour les tests
    // headingHistory.push(45.0); // Ajouter une valeur fixe pour les tests
    // headingHistory.push(60.0); // Ajouter une valeur fixe pour les tests
    // headingHistory.push(40.0); // Ajouter une valeur fixe pour les tests
    // headingHistory.push(42.0); // Ajouter une valeur fixe pour les tests

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
    const angleRad = (heading - 90 - MAP_ROTATION) * Math.PI / 180;

    // Point de la pointe du cône
    const tipX = x + Math.cos(angleRad) * coneLength;
    const tipY = y + Math.sin(angleRad) * coneLength;

    // Calculer les points de la base du triangle (perpendiculaires à la direction)
    const perpAngle = angleRad + Math.PI / 2; // Angle perpendiculaire

    const base1X = x + Math.cos(perpAngle) * (coneWidth / 2);
    const base1Y = y + Math.sin(perpAngle) * (coneWidth / 2);
    const base2X = x - Math.cos(perpAngle) * (coneWidth / 2);
    const base2Y = y - Math.sin(perpAngle) * (coneWidth / 2);

    console.log(`Drawing cone at (${x}, ${y}) with heading ${heading}°`);
    console.log(`Tip: (${tipX}, ${tipY}), Base1: (${base1X}, ${base1Y}), Base2: (${base2X}, ${base2Y})`);

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

if (navigator.geolocation) {
    navigator.geolocation.watchPosition(
        pos => {
            const { latitude, longitude } = pos.coords;
            const heading = pos.coords.heading; // Récupérer la direction
            showGpsDot(latitude, longitude, heading);
        },
        err => {
            console.log(`Erreur de géolocalisation : ${err.code} - ${err.message}`);
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
    );
} else {
    console.log("La géolocalisation n'est pas supportée par ce navigateur.");
}

// Gérer les changements de taille et d'orientation avec ResizeObserver
const resizeObserver = new ResizeObserver((entries) => {
    requestAnimationFrame(handleViewportResize);
});

// Observer les changements de taille sur la fenêtre
resizeObserver.observe(document.documentElement);

// Gérer les changements d'orientation de l'écran (cas particulier)
window.addEventListener('orientationchange', () => {
    // Un seul timeout devrait suffire avec ResizeObserver
    setTimeout(() => {
        handleViewportResize();
        if (lastGpsPosition) {
            showGpsDot(lastGpsPosition.lat, lastGpsPosition.lng, lastGpsPosition.heading);
        }
    }, 100);
});

// Gérer les changements de visibilité du document
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && lastGpsPosition) {
        // Recalculer la position après un court délai quand la page redevient visible
        setTimeout(() => {
            showGpsDot(lastGpsPosition.lat, lastGpsPosition.lng, lastGpsPosition.heading);
        }, 300);
    }
});

// Fonction pour nettoyer la trace (optionnel - peut être appelée via console)
function clearTrail() {
    gpsTrail = [];
    if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

// Ajouter la fonction clearTrail à l'objet global pour permettre son utilisation
window.clearTrail = clearTrail;