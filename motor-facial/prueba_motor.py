"""Prueba de humo del motor facial de GymFlow (la corre probar.sh).

Con el motor ya arrancado en URL y su token en FACE_SIDECAR_TOKEN, comprueba:
  1. /health responde con el token y dice que es el motor de GymFlow con su
     modelo cargado;
  2. sin token, o con uno equivocado, /health y /extract responden 401;
  3. una comparación de ejemplo con las imágenes de muestra que trae
     InsightFace (no son socios ni se guardan): la misma cara, en otra escala
     y con otra luz, supera el umbral de la API (FACE_MATCH_THRESHOLD, 0.38) y
     una cara distinta no;
  4. la prueba de vida rechaza un solo cuadro quieto;
  5. el alta de frente (`frontal_only`, bloque 2.3): tres cuadros de frente dan
     una plantilla que se parece a la cara, y con menos de tres se rechaza.
Imprime una línea por comprobación y sale con 1 si alguna falla.

    FACE_SIDECAR_TOKEN=… python prueba_motor.py http://127.0.0.1:5102
"""
import base64
import importlib.util
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image, ImageEnhance

URL = sys.argv[1].rstrip("/")
TOKEN = os.environ.get("FACE_SIDECAR_TOKEN", "")
UMBRAL = float(os.environ.get("FACE_MATCH_THRESHOLD", "0.38"))
fallas = 0


def linea(bien: bool, texto: str) -> None:
    global fallas
    fallas += 0 if bien else 1
    print(f"  {'✓' if bien else '✗'} {texto}", flush=True)


def pedir(ruta: str, cuerpo: dict | None = None, token: str | None = TOKEN) -> tuple[int, dict]:
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(URL + ruta, data=datos, method="POST" if datos else "GET")
    req.add_header("content-type", "application/json")
    if token is not None:
        req.add_header("x-face-token", token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def cuadro(img: Image.Image) -> str:
    """Como los manda el navegador: data URL en JPEG."""
    b = io.BytesIO()
    img.convert("RGB").save(b, format="JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()


def embedding(img: Image.Image) -> list[float] | None:
    estado, j = pedir("/extract", {"frames": [cuadro(img)], "action": None, "aggregate": False})
    return j.get("embedding") if estado == 200 and j.get("ok") else None


# Espera a que arranque (cargar el modelo toma unos segundos).
salud: dict = {}
for _ in range(180):
    try:
        estado, salud = pedir("/health")
        if estado == 200 and (salud.get("model_loaded") or salud.get("model_error")):
            break
    except (urllib.error.URLError, ConnectionError, OSError):
        pass
    time.sleep(0.5)
else:
    linea(False, f"el motor no respondió en {URL}/health en 90 s")
    sys.exit(1)

linea(salud.get("servicio") == "gymflow-motor-facial" and salud.get("model_loaded") is True,
      f"/health responde con el token: {salud.get('servicio')} {salud.get('version')}, modelo {salud.get('modelo')} "
      + ("cargado" if salud.get("model_loaded") else f"SIN cargar ({salud.get('model_error')})"))

for ruta, cuerpo in (("/health", None), ("/extract", {"frames": ["x"]})):
    sin, _ = pedir(ruta, cuerpo, token=None)
    otro, _ = pedir(ruta, cuerpo, token="otro-token-que-no-es-el-del-motor-123456")
    linea(sin == 401 and otro == 401, f"{ruta} sin token responde {sin} y con otro token {otro} (se espera 401)")

# Imágenes de muestra de InsightFace, sin importar el paquete (solo su ruta).
muestras = os.path.join(os.path.dirname(importlib.util.find_spec("insightface").origin), "data", "images")
cara = Image.open(os.path.join(muestras, "Tom_Hanks_54745.png"))
otra_luz = ImageEnhance.Brightness(cara.resize((int(cara.width * 0.85), int(cara.height * 0.85)))).enhance(1.2)
grupo = Image.open(os.path.join(muestras, "t1.jpg"))  # varias personas: el motor toma la cara más grande

a, b, c = embedding(cara), embedding(otra_luz), embedding(grupo)
if a and b and c:
    va, vb, vc = (np.asarray(v, dtype=float) for v in (a, b, c))
    misma, distinta = float(va @ vb), float(va @ vc)
    linea(len(a) == 512 and abs(float(np.linalg.norm(va)) - 1) < 1e-3, "el embedding tiene 512 números normalizados")
    linea(misma >= UMBRAL, f"comparación de ejemplo, misma cara con otra escala y otra luz: parecido {misma:.2f} (umbral {UMBRAL})")
    linea(distinta < UMBRAL, f"comparación de ejemplo, otra persona: parecido {distinta:.2f}, no se confunde")
else:
    linea(False, "el motor no sacó el rostro de las imágenes de muestra")

estado, j = pedir("/extract", {"frames": [cuadro(cara)], "action": "turn_left", "aggregate": False})
linea(estado == 200 and j.get("liveness_checked") is True and j.get("liveness_ok") is False,
      f"la prueba de vida rechaza un solo cuadro quieto: «{j.get('liveness_reason')}»")

# Alta de frente (bloque 2.3): tres cuadros de la misma cara, a escalas distintas.
tres = [cuadro(cara.resize((int(cara.width * e), int(cara.height * e)))) for e in (1.0, 0.95, 0.9)]
estado, j = pedir("/extract", {"frames": tres, "action": None, "aggregate": True, "frontal_only": True})
if estado == 200 and j.get("ok") and j.get("embedding") and a:
    parecido = float(np.asarray(j["embedding"], dtype=float) @ np.asarray(a, dtype=float))
    linea(j.get("frontal_frames") == 3 and j.get("liveness_checked") is False and parecido >= 0.9,
          f"alta de frente: {j.get('frontal_frames')} cuadros de frente, sin reto, parecido {parecido:.2f} con la misma cara")
else:
    linea(False, f"el alta de frente no dio plantilla: {j.get('error')}")
estado, j = pedir("/extract", {"frames": tres[:1], "action": None, "aggregate": True, "frontal_only": True})
linea(estado == 200 and j.get("ok") is False and j.get("frontal_frames") == 1,
      f"alta de frente con un solo cuadro: se rechaza («{j.get('error')}»)")

sys.exit(1 if fallas else 0)
