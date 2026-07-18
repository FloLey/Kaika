# Générer une vidéo IA à partir d'une simulation de fluide

Document technique pour l'équipe de dev. Objectif : partir d'une simulation de fluide existante et produire une vidéo où chaque image est générée par IA, en suivant la forme du fluide et en restant cohérente d'une image à l'autre.

Ce document part de zéro. Si vous connaissez déjà la diffusion et ControlNet, sautez directement à la partie 4 (« Le principe de la boucle »).

---

## 1. Ce qu'on veut construire, en une phrase

On a déjà une **simulation de fluide** (fumée, encre, liquide... peu importe). Elle produit une suite d'images (des « frames »), image 0, image 1, image 2, etc.

On veut transformer cette suite en une **vidéo stylisée par IA** : par exemple, le fluide devient de la lave, des nuages cosmiques, une créature vivante, une matière imaginaire. Deux contraintes :

1. Chaque image générée doit **suivre la forme** du fluide à cet instant.
2. Les images doivent **s'enchaîner de façon fluide** (pas de clignotement, pas de « saut » brutal d'une image à l'autre).

La difficulté n'est pas de générer UNE belle image. C'est de générer une SUITE d'images cohérentes entre elles. Tout le document tourne autour de ça.

---

## 2. Les briques de base (glossaire pour comprendre la suite)

Lisez cette section une fois. Tout le reste s'appuie dessus.

### 2.1 Un modèle de diffusion (Stable Diffusion, Z-Image...)

C'est un modèle d'IA qui fabrique une image à partir de bruit. Il part d'une image de pur bruit aléatoire (comme la neige d'une vieille télé) et, étape après étape, il « débruite » jusqu'à faire apparaître une image nette. Un texte (le « prompt ») lui dit quoi faire apparaître.

Les modèles « **Turbo** » (SD Turbo, SDXL Turbo, Z-Image Turbo) sont des versions accélérées : là où un modèle normal a besoin de 20 à 50 étapes de débruitage, un modèle Turbo en demande 1 à 4. C'est ce qui les rend assez rapides pour faire de la vidéo (des centaines d'images).

### 2.2 txt2img vs img2img

- **txt2img** (texte vers image) : on part de bruit pur + un prompt. Le modèle invente tout. Aucune image de départ.
- **img2img** (image vers image) : on donne une **image de départ** au modèle, il la transforme selon le prompt. C'est la brique centrale de notre projet : chaque nouvelle image sera un img2img de l'image précédente.

### 2.3 Le paramètre « denoise » (ou « strength ») : LE curseur central

En img2img, il y a un réglage crucial, appelé **denoise** ou **strength**, entre 0 et 1. Il décide à quel point le modèle a le droit de modifier l'image de départ :

- **denoise = 0** : l'image ne change quasiment pas. Sortie = entrée.
- **denoise = 1** : le modèle repart quasiment de zéro, l'image de départ n'a presque plus d'influence.
- **denoise = 0.4 à 0.5** : le modèle garde la structure et l'ambiance de l'image de départ, mais la retravaille.

Retenez ceci : **denoise = le curseur entre « cohérence » (garder l'image d'avant) et « nouveauté » (réinventer)**. C'est le réglage n°1 de tout le projet. On y revient en partie 8.

### 2.4 ControlNet : forcer la structure

Un modèle de diffusion normal fait ce qu'il veut de la composition. **ControlNet** est un module qui vient greffer une contrainte de structure : on lui donne une image de contrôle (un contour, une carte de profondeur, un squelette...) et il force l'image générée à respecter cette structure.

Exemples de types de ControlNet :
- **Canny / lineart / soft-edge** : on donne des contours, l'image générée respecte ces contours.
- **Depth (profondeur)** : on donne une carte de profondeur (proche = clair, loin = sombre), l'image générée respecte ce relief.

Dans notre projet, l'**image de contrôle = la forme extraite du fluide** à cet instant. C'est comme ça que l'IA « suit » le fluide.

### 2.5 Résumé visuel des briques

```
prompt (texte)  ─┐
image de départ ─┼─►  MODÈLE DE DIFFUSION  ─► image générée
image de contrôle┘        (Turbo)
(ControlNet)
      + réglage denoise (0 à 1)
```

---

## 3. L'idée générale : une « boucle fermée »

Le cœur du projet est une **boucle de rétroaction** (feedback loop). En clair :

- Pour fabriquer l'image générée n°`t`, on utilise l'image générée n°`t-1` (la précédente) comme image de départ.
- On la transforme avec le modèle, en suivant la forme du fluide à l'instant `t`.
- Le résultat devient l'image de départ pour l'image `t+1`. Et ainsi de suite.

C'est exactement ce que fait un outil connu qui s'appelle **Deforum** (une extension populaire de Stable Diffusion pour l'animation). Notre projet est une variante de Deforum, sauf que le mouvement ne vient pas d'un zoom/rotation automatique, mais de **notre simulation de fluide**.

Un seul point particulier : la **toute première image** (`t=0`) ne peut pas venir d'une image précédente (il n'y en a pas). On la fabrique donc en txt2img (ou à partir d'une image qu'on choisit). C'est notre « image d'ancrage » : elle définit le style de toute la vidéo, elle mérite du soin.

---

## 4. Le principe de la boucle, en détail

Voici la boucle, étape par étape, pour chaque image `t` de 1 jusqu'à la fin :

```
  ┌──────────────────────────────────────────────────────────┐
  │  Frame de la simulation de fluide à l'instant t           │
  │        │                                                  │
  │        ▼                                                  │
  │  Extraire la "forme"  ──►  image de contrôle (ControlNet) │
  │                                                           │
  │  Image générée t-1  ──►  image de départ (img2img)        │
  │                                                           │
  │  prompt (texte)                                           │
  │        │                                                  │
  │        ▼                                                  │
  │   MODÈLE DE DIFFUSION TURBO                               │
  │   (départ + contrôle + prompt + denoise)                 │
  │        │                                                  │
  │        ▼                                                  │
  │   Image générée t   ──────────────► (devient le départ    │
  │                                       de l'image t+1)     │
  └──────────────────────────────────────────────────────────┘
```

Les trois « entrées » à chaque tour :
1. **L'image de contrôle** : la forme du fluide à l'instant `t`. Elle dit *où* est la matière.
2. **L'image de départ** : l'image générée juste avant. Elle assure la *cohérence* (les couleurs, la texture, l'identité de la matière restent).
3. **Le prompt** : le style voulu. Il peut rester identique toute la vidéo, ou évoluer doucement.

---

## 5. Ce qu'on extrait de la simulation (plus riche qu'un simple contour)

Point important, souvent oublié : une simulation de fluide ne fournit pas juste une image. Elle calcule des **champs de données** à chaque instant. Selon votre moteur (Houdini, Blender/Mantaflow, un solveur maison, WebGL...), vous avez typiquement accès à :

- **La densité** : où il y a de la matière et combien. C'est l'image « brute » du fluide.
- **La vitesse** : pour chaque point de l'image, dans quelle direction et à quelle vitesse la matière bouge. C'est un champ de deux nombres par pixel (vitesse horizontale `u`, vitesse verticale `v`).
- **La vorticité** : où ça tourbillonne.
- **La pression** : moins utile ici.

On peut transformer ces champs en images de contrôle :

| Champ de la simu | Transformation | Type de ControlNet |
|---|---|---|
| Densité | seuillage / détection de contours (Canny) | structurel (contours) |
| Densité | utilisée comme carte de profondeur | depth |
| Vorticité / gradients | soft-edge / scribble | textures qui suivent les tourbillons |
| **Vitesse (u, v)** | **utilisée pour déformer l'image précédente** | **voir partie 7, c'est l'atout clé** |

Le point à retenir absolument : **le champ de vitesse est de l'information en or**. La plupart des gens qui font ce genre de vidéo doivent *deviner* le mouvement à partir d'une vidéo existante (une technique appelée « flux optique estimé »), avec des erreurs. Nous, on a le mouvement **exact**, directement calculé par le solveur. Ça nous met dans la meilleure position possible. On exploite ça au workflow B (partie 7).

---

## 6. Trois workflows possibles

### Workflow A : « ControlNet feedback » (le plus simple, celui décrit au départ)

```
forme(t) ─► ControlNet
image(t-1) ─► image de départ        ──►  MODÈLE  ──►  image(t)
prompt
```

La forme impose la structure, l'image précédente porte la cohérence, le denoise dose le mélange.

- **Avantages** : simple à monter, marche tout de suite.
- **Défaut** : la cohérence est « passive ». On réinjecte l'image d'avant telle quelle, sans dire au modèle *comment* la matière a bougé entre les deux images. Résultat : ça a tendance à **clignoter** (« flicker ») et à « baver » quand le mouvement est rapide.

C'est le bon point de départ pour valider le pipeline, mais pas la version finale.

### Workflow B : « Feedback déformé par le flux » (RECOMMANDÉ)

```
image(t-1) ─► DÉFORMÉE par le champ de vitesse(t) ─► image de départ "déjà en mouvement"
forme(t)   ─► ControlNet                                    ──► MODÈLE ──► image(t)
prompt
```

La seule différence avec A : **avant** de donner l'image précédente au modèle, on la **déforme** en utilisant le champ de vitesse de la simulation. Concrètement, chaque pixel de l'image précédente est poussé dans la direction où la matière bouge. L'image de départ arrive donc « déjà dans la bonne pose », et le modèle n'a plus qu'à la nettoyer au lieu de tout réinventer.

- **Avantages** : cohérence beaucoup plus forte, énormément moins de clignotement, vraie sensation de matière qui coule. On peut baisser le denoise (donc encore plus de stabilité).
- **Pourquoi c'est notre force** : cette déformation exige de connaître le mouvement. On l'a exactement (le champ de vitesse). Les outils grand public l'estiment approximativement. **C'est l'idée à essayer en priorité.**

C'est la même famille de techniques que le mode « hybrid video » de Deforum, ou l'esprit d'outils comme EBSynth / TokenFlow.

### Workflow C : temps réel / interactif

SD Turbo génère en 1 à 4 étapes : assez rapide pour une boucle **quasi temps réel**. Avec un outil appelé **StreamDiffusion** (conçu pour l'img2img en flux continu), on peut transformer le fluide *pendant* qu'il tourne, éventuellement piloté par le son.

- **Usage** : installation live, VJ, prototype interactif.
- **Compromis** : qualité un peu plus basse, ControlNet plus limité en direct.

Recommandation générale : **prototyper avec A**, **produire la version finale avec B**, et **garder C en tête** si on veut une version live plus tard.

---

## 7. Le cœur technique : déformer l'image par le champ de vitesse (« warping »)

C'est la partie la plus importante et la moins évidente. Prenons le temps.

### 7.1 L'idée en mots

Le champ de vitesse nous dit, pour chaque pixel, de combien la matière s'est déplacée entre l'image `t-1` et l'image `t`. Si on applique ce déplacement à l'image générée précédente, on obtient une prédiction de « à quoi devrait ressembler l'image `t` si on se contentait de faire bouger l'image d'avant ». Cette prédiction n'est pas parfaite (elle a des trous, des étirements), mais elle est un excellent **point de départ** pour l'img2img : le modèle corrige les défauts au lieu de repartir de zéro.

En traitement d'image, cette opération s'appelle un **warp** (déformation), et la fonction standard pour le faire s'appelle `remap` (dans la librairie OpenCV).

### 7.2 Comment marche `remap`

`remap` répond à la question : « pour construire l'image de sortie, où faut-il aller chercher chaque pixel dans l'image d'entrée ? » On lui fournit deux « cartes » (`map_x`, `map_y`) qui donnent, pour chaque pixel de sortie, les coordonnées source dans l'image d'entrée. On construit ces cartes à partir du champ de vitesse.

### 7.3 Le code (Python + OpenCV)

```python
import numpy as np
import cv2

def warp_image(image_prev, flow_u, flow_v):
    """
    Déforme l'image précédente selon le champ de vitesse de la simu.

    image_prev : l'image générée précédente (H x W x 3, uint8)
    flow_u     : vitesse horizontale par pixel (H x W, float) -> déplacement en x
    flow_v     : vitesse verticale par pixel   (H x W, float) -> déplacement en y

    NB : selon votre solveur, il faudra peut-être multiplier flow par un
    facteur d'échelle (pixels par pas de temps) et/ou inverser le signe.
    À calibrer visuellement sur 2-3 images.
    """
    H, W = image_prev.shape[:2]

    # Grille de coordonnées de base (chaque pixel pointe vers lui-même)
    grid_x, grid_y = np.meshgrid(np.arange(W), np.arange(H))

    # On va chercher le pixel "d'où vient" la matière : on soustrait le flux
    map_x = (grid_x - flow_u).astype(np.float32)
    map_y = (grid_y - flow_v).astype(np.float32)

    warped = cv2.remap(
        image_prev, map_x, map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT
    )
    return warped
```

Ce petit bout de code est le vrai secret du workflow B. Le reste (appeler le modèle) est standard.

---

## 8. La boucle complète en Python (avec diffusers)

Voici un squelette réaliste utilisant la librairie **diffusers** de Hugging Face, avec un modèle Turbo + ControlNet. Il est commenté ligne à ligne. Adaptez les noms de modèles et les chemins.

> Note importante sur les modèles : à ce jour, **SDXL Turbo** s'utilise très bien avec diffusers et dispose de ControlNet matures, donc c'est le choix le plus documenté pour un script Python. **Z-Image Turbo** est excellent en qualité mais son intégration la plus simple passe aujourd'hui par **ComfyUI** (voir partie 9). Stratégie conseillée : prototyper la logique en Python avec SDXL/SD Turbo, puis, si on veut la qualité maximale, reconstruire la même boucle dans ComfyUI avec Z-Image Turbo.

```python
import torch
import numpy as np
import cv2
from PIL import Image
from diffusers import (
    StableDiffusionXLControlNetImg2ImgPipeline,
    ControlNetModel,
)

# ---------------------------------------------------------------
# 1. Chargement du modèle (une seule fois)
# ---------------------------------------------------------------
# Sur Mac Apple Silicon, on utilise le backend "mps".
device = "mps" if torch.backends.mps.is_available() else "cpu"

controlnet = ControlNetModel.from_pretrained(
    "diffusers/controlnet-canny-sdxl-1.0",   # ControlNet contours pour SDXL
    torch_dtype=torch.float16,
)
pipe = StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
    "stabilityai/sdxl-turbo",                 # modèle Turbo
    controlnet=controlnet,
    torch_dtype=torch.float16,
).to(device)

PROMPT = "flowing molten lava, glowing embers, dark cinematic background"
NEG    = "blurry, low quality, text, watermark"

# ---------------------------------------------------------------
# 2. Fonctions utilitaires
# ---------------------------------------------------------------
def extract_control(density_frame):
    """Transforme la densité du fluide en image de contrôle (contours Canny)."""
    gray = cv2.cvtColor(density_frame, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 80, 160)
    edges_rgb = cv2.cvtColor(edges, cv2.COLOR_GRAY2RGB)
    return Image.fromarray(edges_rgb)

def warp_image(image_prev, flow_u, flow_v):
    H, W = image_prev.shape[:2]
    grid_x, grid_y = np.meshgrid(np.arange(W), np.arange(H))
    map_x = (grid_x - flow_u).astype(np.float32)
    map_y = (grid_y - flow_v).astype(np.float32)
    return cv2.remap(image_prev, map_x, map_y,
                     interpolation=cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_REFLECT)

def match_colors_lab(img, reference):
    """Recale les couleurs de img sur celles d'une image de référence (anti-dérive)."""
    img_lab = cv2.cvtColor(img, cv2.COLOR_RGB2LAB).astype(np.float32)
    ref_lab = cv2.cvtColor(reference, cv2.COLOR_RGB2LAB).astype(np.float32)
    for c in range(3):
        img_lab[..., c] = ((img_lab[..., c] - img_lab[..., c].mean())
                           / (img_lab[..., c].std() + 1e-6)
                           * ref_lab[..., c].std() + ref_lab[..., c].mean())
    img_lab = np.clip(img_lab, 0, 255).astype(np.uint8)
    return cv2.cvtColor(img_lab, cv2.COLOR_LAB2RGB)

# ---------------------------------------------------------------
# 3. Image d'ancrage (première image, en txt2img simplifié)
# ---------------------------------------------------------------
# Ici on génère la frame 0 à partir de la seule forme (denoise élevé),
# car il n'y a pas d'image précédente.
density_0, _, _ = load_sim_frame(0)          # <-- votre fonction : renvoie (densité, u, v)
control_0 = extract_control(density_0)
frame0 = pipe(
    prompt=PROMPT, negative_prompt=NEG,
    image=Image.fromarray(density_0),        # départ = densité brute
    control_image=control_0,
    strength=0.9,                            # fort : on invente le style
    num_inference_steps=4,
    guidance_scale=0.0,                      # les modèles Turbo se passent de guidance
    controlnet_conditioning_scale=0.8,
).images[0]

prev = np.array(frame0)
anchor = prev.copy()                         # référence couleur pour l'anti-dérive
save_frame(0, prev)

# ---------------------------------------------------------------
# 4. La boucle principale
# ---------------------------------------------------------------
N_FRAMES = 300
DENOISE  = 0.45          # LE réglage clé (voir partie 10)

for t in range(1, N_FRAMES):
    density, flow_u, flow_v = load_sim_frame(t)

    # (B) déformer l'image précédente par le champ de vitesse
    warped = warp_image(prev, flow_u, flow_v)

    # image de contrôle = forme du fluide à l'instant t
    control = extract_control(density)

    # génération de l'image t
    out = pipe(
        prompt=PROMPT, negative_prompt=NEG,
        image=Image.fromarray(warped),           # départ = image précédente DÉFORMÉE
        control_image=control,
        strength=DENOISE,
        num_inference_steps=4,
        guidance_scale=0.0,
        controlnet_conditioning_scale=0.8,
    ).images[0]
    out = np.array(out)

    # anti-dérive : recaler les couleurs tous les 10 frames
    if t % 10 == 0:
        out = match_colors_lab(out, anchor)

    save_frame(t, out)
    prev = out

# ---------------------------------------------------------------
# 5. Assembler les images en vidéo (ffmpeg)
#    ffmpeg -framerate 24 -i frame_%05d.png -c:v libx264 -pix_fmt yuv420p out.mp4
# ---------------------------------------------------------------
```

Ce que votre équipe doit fournir : la fonction `load_sim_frame(t)` qui renvoie, pour l'image `t`, la densité (image couleur ou niveaux de gris) et le champ de vitesse (`u`, `v`). Le reste est fourni ci-dessus. C'est là que le travail d'intégration se concentre : **exporter proprement le champ de vitesse depuis votre moteur de simulation.**

---

## 9. Alternative sans coder : ComfyUI

Si l'équipe préfère un outil visuel plutôt qu'un script, **ComfyUI** est la référence. C'est un logiciel « node-based » : on relie des boîtes (charger le modèle, charger l'image, appliquer ControlNet, générer...) avec des câbles. Il tourne nativement sur Mac Apple Silicon (backend MPS).

Points utiles :
- ComfyUI fournit un **template officiel Z-Image Turbo**, donc c'est la voie la plus simple pour utiliser Z-Image Turbo (meilleure qualité).
- Il existe des nodes de **flux optique** (`Unimatch`, `OpticalFlowMaskModulation` du pack RyanOnTheInside, `MaskOptFlow`) pour gérer la déformation entre images.
- On peut y reconstruire le workflow A facilement, et le workflow B avec un peu plus d'effort (injection du warp).

Conseil pratique : **prototyper une image isolée dans ComfyUI** (valider que forme + prompt donnent le style voulu), puis décider si on reste dans ComfyUI ou si on passe au script Python pour mieux contrôler la boucle et le warp.

---

## 10. Le réglage n°1 : le denoise (strength)

Tout se joue sur ce curseur. Résumé pratique :

| Valeur de denoise | Effet |
|---|---|
| ~0.7 et plus | Chaque image se réinvente trop. Clignotement, le fluide « décroche ». |
| **~0.35 à 0.55** | **Zone juste. La structure suit le fluide, l'identité de la matière tient.** |
| ~0.2 et moins | Image quasi figée, la matière s'accumule en bouillie, la forme ne « traverse » plus. |

Astuce avancée : au lieu d'une valeur fixe, **faire varier le denoise selon le mouvement** (plus haut quand la simu bouge beaucoup, plus bas dans les phases calmes). C'est ce que Deforum appelle le « strength_schedule ».

---

## 11. La dérive : l'ennemi d'une boucle fermée

Une boucle qui se nourrit de sa propre sortie **dérive** avec le temps : les couleurs saturent, un motif visuel « attracteur » s'installe, la variété s'effondre. C'est un phénomène documenté (parfois appelé « model collapse » ou « résonance neuronale » dans les boucles de rétroaction).

Boîte à outils pour tenir la barre (toutes utilisables ensemble) :

1. **Recalage colorimétrique LAB** : tous les N images, réaligner la palette sur une image de référence (l'image d'ancrage). Fourni dans le code, fonction `match_colors_lab`. C'est le remède le plus efficace.
2. **Garder le denoise dans la zone juste** : ne jamais le laisser s'effondrer trop bas trop longtemps.
3. **Réinjecter un peu de bruit** sur l'image de départ déformée, pour rouvrir un peu de liberté au modèle.
4. **Ré-ancrage périodique** : toutes les X images, refaire une génération plus forte (denoise élevé) qui remet le style sur les rails.
5. **Keyframes + interpolation** : générer 1 image sur N en qualité, puis interpoler les intermédiaires avec un outil de flux optique (RIFE). Moins de calcul, mouvement plus fluide.

---

## 12. Choix du modèle : SD Turbo vs Z-Image Turbo

| Critère | SD Turbo / SDXL Turbo | Z-Image Turbo |
|---|---|---|
| Vitesse par image | Très rapide (1 à 4 étapes) | ~2 à 3 s en 1024px sur Apple Silicon |
| Qualité d'image | Correcte (base SD 2.1 / SDXL) | Nettement supérieure (6 milliards de paramètres) |
| ControlNet | Écosystème mature côté SDXL | ControlNet Union 2.1 disponible, solide |
| Intégration Python (diffusers) | Excellente, très documentée | Plus simple via ComfyUI aujourd'hui |
| Bon pour | Prototype, temps réel, workflow C | Rendu final de qualité, workflows A/B |
| Licence | Ouverte | Apache 2.0 (très permissive) |

**Stratégie recommandée :** prototyper et régler le mouvement/prompt avec SD ou SDXL Turbo (feedback rapide), puis produire la version finale avec Z-Image Turbo + ControlNet Union dans ComfyUI pour la qualité.

Note matériel : Z-Image Turbo demande un Mac Apple Silicon avec au moins 16 Go de mémoire unifiée (32 Go confortable).

---

## 13. Installation sur Mac (Apple Silicon)

Grandes lignes. Détails précis dans les liens de la partie 15.

**Option ComfyUI (recommandée pour démarrer)**
1. Installer ComfyUI (dernière version, support MPS natif).
2. Charger le template officiel Z-Image Turbo, placer les 3 fichiers de modèle dans les bons dossiers (le template indique lesquels).
3. Ajouter le pack ControlNet Union 2.1 pour Z-Image.
4. Tester la génération d'une image isolée à partir d'une forme + prompt.

**Option script Python (pour la boucle B sur mesure)**
1. Créer un environnement Python (venv ou conda).
2. `pip install torch torchvision diffusers transformers accelerate opencv-python pillow`
3. Vérifier que PyTorch voit le backend MPS (`torch.backends.mps.is_available()` doit renvoyer `True`).
4. Récupérer le squelette de la partie 8, brancher `load_sim_frame`.

---

## 14. Plan d'implémentation, étape par étape

1. **Export depuis la simu.** Faire produire à la simulation, pour chaque image : une image de densité + le champ de vitesse (`u`, `v`), même en basse résolution. C'est le prérequis du workflow B. À faire en premier.
2. **Prototype 1 image.** Dans ComfyUI (ou en Python), avec Z-Image ou SDXL Turbo + ControlNet, valider que forme + prompt donnent l'esthétique voulue sur UNE image isolée.
3. **Boucle simple (workflow A) sur ~30 images.** Régler le denoise (démarrer à 0.45) et activer le recalage LAB. Observer le clignotement.
4. **Passer au workflow B.** Ajouter la déformation par le champ de vitesse avant l'img2img (le script Python est le plus adapté ici). Comparer le clignotement avec l'étape 3 : il doit nettement baisser.
5. **Ajouter les garde-fous.** Ré-ancrage périodique + variation du denoise. Rendre la séquence complète.
6. **Assembler en vidéo** avec ffmpeg (24 images/s typiquement).
7. **Optionnel : version live.** Porter la logique sur SD Turbo + StreamDiffusion pour une version temps réel / audio-réactive.

---

## 15. Ressources et liens

**Comprendre l'animation par boucle (Deforum)**
- Guide d'animation Deforum (paramètres, strength_schedule) : https://rentry.org/AnimAnon-Deforum
- Réglages Deforum expliqués : https://dreamingcomputers.com/deforum-stable-diffusion/deforum-stable-diffusion-settings/
- Deforum + ControlNet, animations sans clignotement : https://learn.thinkdiffusion.com/deforum-controlnet/
- Tutoriel complet clip musical avec Deforum : https://plainenglish.io/blog/making-a-music-video-with-stable-diffusion-and-deforum-an-in-depth-tutorial

**Z-Image Turbo (modèle et ControlNet)**
- Doc officielle ComfyUI, template Z-Image Turbo : https://docs.comfy.org/tutorials/image/z-image/z-image-turbo
- Z-Image Turbo + ControlNet Union 2.1 dans ComfyUI : https://stable-diffusion-art.com/z-image-controlnet-union/
- Z-Image Turbo sur Apple Silicon (installation) : https://medium.com/@tchpnk/z-image-turbo-comfyui-on-apple-silicon-2026-0aa78d05132d
- Guide Mac Z-Image (optimisation) : https://z-image.me/en/blog/How_to_Use_Z-Image_on_Mac_en
- Images cohérentes avec ControlNet (Z-Image, T2I) : https://www.nextdiffusion.ai/tutorials/consistent-z-image-turbo-images-controlnet-comfyui-t2i

**Flux optique dans ComfyUI**
- Node Unimatch (estimation de flux optique) : https://www.runcomfy.com/comfyui-nodes/comfyui_controlnet_aux/Unimatch_OptFlowPreprocessor
- Node OpticalFlowMaskModulation (RyanOnTheInside) : https://www.runcomfy.com/comfyui-nodes/ComfyUI_RyanOnTheInside/OpticalFlowMaskModulation
- Node MaskOptFlow (masque par flux) : https://www.runcomfy.com/comfyui-nodes/comfyui_controlnet_aux/MaskOptFlow

**Cohérence temporelle / vidéo (approfondir)**
- Video ControlNet (cohérence temporelle, article de recherche) : https://arxiv.org/pdf/2305.19193
- Vue « chaîne de Markov » des boucles de rétroaction et model collapse : https://arxiv.org/pdf/2602.19033

**Documentation générale**
- diffusers (Hugging Face), pipelines img2img et ControlNet : https://huggingface.co/docs/diffusers
- OpenCV `remap` (la fonction de déformation) : https://docs.opencv.org/4.x/da/d54/group__imgproc__transform.html

---

## 16. Ce qu'il faut retenir en 5 points

1. Le projet est une **boucle** : chaque image est un img2img de la précédente, guidé par la forme du fluide.
2. Le **denoise** (entre ~0.35 et 0.55) est le réglage central : trop haut ça clignote, trop bas ça fige.
3. Notre atout unique : on a le **champ de vitesse exact** de la simu. On l'utilise pour **déformer l'image précédente avant** la génération (workflow B). C'est ce qui tue le clignotement.
4. Une boucle fermée **dérive** : compenser avec le recalage couleur LAB et le ré-ancrage périodique.
5. **SD/SDXL Turbo pour prototyper vite** (et le temps réel), **Z-Image Turbo pour le rendu final de qualité** (via ComfyUI).