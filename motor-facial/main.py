"""GymFlow — motor facial (sin estado).

Copia PROPIA de GymFlow del sidecar facial de HRFlow
(`hrflow-next/apps/face-sidecar/main.py`, tomada el 2026-11-19; auditoría 8,
bloque 0.4, hallazgos 27-03 y A5-N4): la entrada del gimnasio ya no depende de
lo que se cambie o se limpie en otro producto.

Extrae el embedding facial (InsightFace buffalo_sc, 512 números normalizados)
y verifica la prueba de vida activa por la geometría de los 5 puntos de la
cara. NO tiene estado ni base: recibe cuadros, devuelve el embedding y el
resultado de la prueba de vida, y descarta la imagen. La comparación, el
cifrado de la plantilla y la regla de la puerta viven en la API
(`src/modules/access/face.engine.ts`).

Lo que cambió respecto a HRFlow. Lo demás es idéntico, con el mismo modelo y
las mismas versiones, para que los rostros ya registrados se sigan
reconociendo igual:
  · el token es OBLIGATORIO: sin `FACE_SIDECAR_TOKEN` (32 caracteres o más) el
    motor no arranca, y toda ruta, `/health` incluida, responde 401 sin la
    cabecera `X-Face-Token` correcta (en HRFlow era opcional y nadie lo ponía);
  · escucha solo en 127.0.0.1 (lo fija `run.sh`; HRFlow escuchaba en 0.0.0.0);
  · sin CORS ni páginas de documentación: solo la API le habla;
  · el modelo vive en su propia carpeta (`FACE_MODEL_ROOT`, por omisión
    `modelo/`) y nunca se descarga en marcha: lo instala `preparar.sh`, que
    verifica su huella;
  · `/health` dice qué servicio es y su versión.

Se instala con `preparar.sh`, se arranca con `run.sh` (lo hace gymflow.sh) y
se prueba con `probar.sh`.
"""
import base64
import hmac
import logging
import os
import sys
from io import BytesIO

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel

# Bajo uvicorn en un contenedor (sin TTY), el stdout de Python queda
# block-buffered: los print() de InsightFace al preparar el modelo (el banner
# "find model: det_*.onnx / Applied providers / set det-size") y cualquier otra
# salida se quedan en el buffer y NUNCA llegan a los logs del contenedor — el
# arranque se ve mudo aunque el modelo cargue. Forzamos line-buffering aquí para
# no depender de que PYTHONUNBUFFERED esté seteado en el entorno.
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

# Docker captura stdout/stderr como logs del servicio: que los errores reales
# queden visibles ahí en vez de disfrazarse como "no se detectó rostro".
# IMPORTANTE: bajo uvicorn, un logger propio configurado por basicConfig NO se
# ve (uvicorn reconfigura el logging al arrancar). Colgamos el nuestro del
# logger "uvicorn.error" —que siempre tiene handler— para que el banner del
# modelo y los warnings de detección lleguen de verdad a los logs.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("uvicorn.error").getChild("motor-facial")
log.setLevel(logging.INFO)

# ── Umbrales de liveness (env, con defaults del app viejo) ────────────────────
LIVENESS_ENABLED = os.getenv("FACE_LIVENESS_ENABLED", "true").lower() != "false"
YAW_DELTA = float(os.getenv("FACE_LIVENESS_YAW_DELTA", "0.12"))
SCALE_DELTA = float(os.getenv("FACE_LIVENESS_SCALE_DELTA", "0.12"))
RIGID_EPS = float(os.getenv("FACE_LIVENESS_RIGID_EPS", "0.03"))
MIN_FRAMES = int(os.getenv("FACE_LIVENESS_MIN_FRAMES", "3"))

# ── Captura de frente para el alta (bloque 2.3, hallazgo 6-09) ────────────────
# Un cuadro cuenta como «de frente» si la nariz se aparta del centro de los
# ojos menos de esta fracción de la distancia entre ellos. Solo decide qué
# cuadros entran al promedio del alta cuando se pide `frontal_only`; no toca
# la prueba de vida ni la lectura de la Estación.
FRONTAL_YAW = float(os.getenv("FACE_FRONTAL_YAW", "0.20"))
FRONTAL_MIN_FRAMES = int(os.getenv("FACE_FRONTAL_MIN_FRAMES", "3"))

# Tamaño de detección de InsightFace. Configurable por env: un rostro que queda
# chico en el cuadro puede caer por debajo del umbral a 320px pero detectarse a
# 640px (a costa de más CPU). Default = el histórico.
DET_SIZE = int(os.getenv("FACE_DET_SIZE", "320"))

# Quién es, para quien lo arranca o lo revisa (gymflow.sh, probar.sh).
SERVICIO = "gymflow-motor-facial"
VERSION = "1.1.0"
# El modelo vive en la carpeta del motor, no en ~/.insightface (que se compartía
# con HRFlow). Lo instala `preparar.sh` y verifica su huella.
MODEL_NAME = "buffalo_sc"
MODEL_FILES = ("det_500m.onnx", "w600k_mbf.onnx")
MODEL_ROOT = os.path.abspath(os.path.expanduser(
    os.getenv("FACE_MODEL_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "modelo")
))

_app_model = None  # FaceAnalysis, cargado una sola vez
_model_error: str | None = None  # último error al cargar el modelo, si lo hubo


def _cargar_modelo():
    """Carga el modelo. Deja que cualquier excepción SUBA (no la atrapa aquí):
    quien llame decide si es fatal (arranque) o recuperable (bajo demanda)."""
    global _app_model, _model_error
    from insightface.app import FaceAnalysis

    # Nunca se descarga en marcha (InsightFace lo bajaría de GitHub si no lo
    # encuentra): el modelo es parte de la instalación, con su huella.
    carpeta = os.path.join(MODEL_ROOT, "models", MODEL_NAME)
    faltan = [f for f in MODEL_FILES if not os.path.isfile(os.path.join(carpeta, f))]
    if faltan:
        raise RuntimeError(
            f"Falta el modelo {MODEL_NAME} en {carpeta} ({', '.join(faltan)}). Instálalo con motor-facial/preparar.sh"
        )
    log.info("Cargando modelo InsightFace %s de %s (det_size=%d)...", MODEL_NAME, carpeta, DET_SIZE)
    m = FaceAnalysis(name=MODEL_NAME, root=MODEL_ROOT, providers=["CPUExecutionProvider"])
    m.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE))
    _app_model = m
    _model_error = None
    log.info("Modelo cargado correctamente.")


def _get_model():
    """Devuelve el modelo, cargándolo perezosamente si el arranque no pudo.
    Si falla, SUBE la excepción (no la convierte en 'no rostro')."""
    global _model_error
    if _app_model is None:
        try:
            _cargar_modelo()
        except Exception as e:
            _model_error = f"{type(e).__name__}: {e}"
            log.exception("No se pudo cargar el modelo InsightFace")
            raise
    return _app_model


def _decode(b64: str) -> np.ndarray:
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    img = Image.open(BytesIO(base64.b64decode(b64))).convert("RGB")
    # ascontiguousarray: el slice [:, :, ::-1] deja un array de stride negativo y
    # NO contiguo, que algunos ops de onnxruntime/OpenCV dentro del detector
    # rechazan ("Layout of the output array is incompatible"). Forzar contigüidad
    # lo evita; sin esto el detector podía fallar TODOS los cuadros.
    return np.ascontiguousarray(np.array(img)[:, :, ::-1])  # RGB -> BGR


def _primary_face(image: np.ndarray, modelo):
    faces = modelo.get(image)
    if not faces:
        return None
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))


def _descriptor(face) -> dict:
    kps = np.asarray(face.kps, dtype=np.float32)
    left_eye, right_eye, nose = kps[0], kps[1], kps[2]
    eye_center = (left_eye + right_eye) / 2.0
    eye_dist = float(np.linalg.norm(right_eye - left_eye)) + 1e-6
    yaw = float((nose[0] - eye_center[0]) / eye_dist)
    return {"yaw": yaw, "eye_dist": eye_dist}


def _verify_active(descs: list[dict], action: str) -> tuple[bool, str]:
    if len(descs) < MIN_FRAMES:
        return False, "Necesito verte en varios cuadros. Mantente frente a la cámara."
    yaws = [d["yaw"] for d in descs]
    eye_dists = [d["eye_dist"] for d in descs]
    yaw_range = max(yaws) - min(yaws)
    scale_ratio = max(eye_dists) / (min(eye_dists) + 1e-6) - 1.0

    if action in ("turn_left", "turn_right"):
        if yaw_range < YAW_DELTA:
            return False, "No detecté el giro de cabeza. Repite el movimiento."
    elif action == "move_closer":
        if scale_ratio < SCALE_DELTA:
            return False, "Acércate más a la cámara."
    else:
        return False, "Reto desconocido."

    if yaw_range < RIGID_EPS and scale_ratio < RIGID_EPS:
        return False, "Posible foto estática. Realiza el movimiento indicado."
    return True, ""


# TOKEN OBLIGATORIO (A5-N4). La API lo manda en la cabecera X-Face-Token; sin
# ella, o con otro valor, TODA ruta responde 401 (también /health: así la API
# sabe desde la primera consulta si su token sirve). Sin token configurado el
# motor no arranca: en HRFlow era opcional, quedaba abierto y nadie lo ponía.
FACE_SIDECAR_TOKEN = os.getenv("FACE_SIDECAR_TOKEN", "")
TOKEN_MINIMO = 32
if len(FACE_SIDECAR_TOKEN) < TOKEN_MINIMO:
    print(
        f"El motor facial no arrancó: falta FACE_SIDECAR_TOKEN ({TOKEN_MINIMO} caracteres o más). "
        "gymflow.sh lo toma de motor-facial/token.sh; a mano: FACE_SIDECAR_TOKEN=$(bash motor-facial/token.sh) bash motor-facial/run.sh",
        file=sys.stderr,
    )
    sys.exit(1)
_TOKEN = FACE_SIDECAR_TOKEN.encode("utf-8")


def requiere_token(x_face_token: str | None = Header(default=None)):
    # Se comparan bytes: compare_digest rechaza textos con caracteres fuera de ASCII.
    if not x_face_token or not hmac.compare_digest(x_face_token.encode("utf-8"), _TOKEN):
        raise HTTPException(status_code=401, detail="No autorizado")


# Sin CORS ni páginas de documentación: el motor solo lo llama la API, de
# servidor a servidor, nunca un navegador.
app = FastAPI(
    title="GymFlow · motor facial",
    docs_url=None, redoc_url=None, openapi_url=None,
    dependencies=[Depends(requiere_token)],
)


@app.on_event("startup")
def _startup():
    # Carga el modelo YA al arrancar: si algo va a fallar (descarga bloqueada,
    # falta de memoria, etc.) se ve en los logs de arranque del contenedor, no
    # escondido en la primera captura de un usuario real.
    global _model_error
    try:
        _cargar_modelo()
    except Exception as e:
        # No tumba el servicio: /extract reintentará cargarlo bajo demanda (por
        # si fue un problema transitorio de red). Pero SÍ dejamos el motivo en
        # /health desde ya — antes quedaba en null hasta la primera /extract y
        # ocultaba la causa real de "reconocimiento no disponible".
        _model_error = f"{type(e).__name__}: {e}"
        log.warning("El modelo no cargó al arrancar (%s); se reintentará en la primera petición.", e)


class ExtractRequest(BaseModel):
    frames: list[str]  # base64 (data URL o crudo)
    action: str | None = None  # reto de liveness; None = sin verificación activa
    # Enrolamiento: promedia TODOS los cuadros válidos en una sola plantilla
    # (menos sensible a un cuadro malo). Al checar se deja en False.
    aggregate: bool = False
    # Alta de frente (bloque 2.3): con `aggregate`, promedia SOLO los cuadros de
    # frente y rechaza si quedan menos de FRONTAL_MIN_FRAMES. Por omisión, como
    # siempre: quien no lo manda recibe exactamente lo de antes.
    frontal_only: bool = False


class ExtractResponse(BaseModel):
    ok: bool
    embedding: list[float] | None = None
    faces_detected: int = 0
    # Cuántos de los cuadros con rostro están de frente (|yaw| <= FRONTAL_YAW).
    frontal_frames: int = 0
    liveness_checked: bool = False
    liveness_ok: bool = False
    liveness_reason: str = ""
    error: str | None = None


@app.get("/health")
def health():
    return {
        "status": "ok",
        "servicio": SERVICIO,
        "version": VERSION,
        "modelo": MODEL_NAME,
        "liveness_enabled": LIVENESS_ENABLED,
        "model_loaded": _app_model is not None,
        "model_error": _model_error,
    }


@app.post("/extract", response_model=ExtractResponse)
def extract(req: ExtractRequest, _: None = Depends(requiere_token)) -> ExtractResponse:
    if not req.frames:
        return ExtractResponse(ok=False, error="Sin cuadros")

    # Si el modelo no carga, esto lanza y FastAPI responde 500 con el motivo
    # real (visible para quien llama y en los logs) — nunca se disfraza de
    # "no se detectó rostro".
    try:
        modelo = _get_model()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Modelo facial no disponible: {e}")

    faces = []  # (face, descriptor) por cuadro con rostro
    decode_errores = 0
    shapes = []  # (alto, ancho) de cada cuadro que sí decodificó — para diagnóstico
    for i, b64 in enumerate(req.frames):
        try:
            img = _decode(b64)
            shapes.append((img.shape[0], img.shape[1]))
            face = _primary_face(img, modelo)
        except Exception as e:
            decode_errores += 1
            log.warning("Cuadro %d: error al decodificar/detectar: %s", i, e)
            face = None
        if face is not None:
            faces.append((face, _descriptor(face)))

    if not faces:
        if decode_errores == len(req.frames):
            # Ningún cuadro se pudo ni siquiera leer: probablemente el problema
            # es la imagen que llegó (formato/tamaño), no la ausencia de rostro.
            log.error("Los %d cuadros fallaron al decodificar; ver warnings arriba.", len(req.frames))
            return ExtractResponse(
                ok=False, faces_detected=0,
                error="No se pudieron procesar las imágenes recibidas (revisa la bitácora del motor facial)",
            )
        # Decodificaron bien pero el detector no encontró ninguna cara. Antes esto
        # era MUDO en los logs; dejamos rastro de cuántos cuadros llegaron y de qué
        # tamaño (alto, ancho) para distinguir "imagen sana sin cara detectable"
        # (→ luz/encuadre/umbral/modelo) de "imagen rara" (chica, negra, girada).
        log.warning(
            "Detección vacía: %d/%d cuadros decodificaron, tamaños=%s, det_size=%d — 0 rostros.",
            len(shapes), len(req.frames), shapes[:4], DET_SIZE,
        )
        return ExtractResponse(ok=False, faces_detected=0, error="No se detectó ningún rostro")

    # Liveness activo (si se pidió un reto y está habilitado).
    liveness_checked = False
    liveness_ok = True
    liveness_reason = ""
    if LIVENESS_ENABLED and req.action:
        liveness_checked = True
        liveness_ok, liveness_reason = _verify_active([d for _, d in faces], req.action)
        if not liveness_ok:
            return ExtractResponse(
                ok=False,
                faces_detected=len(faces),
                liveness_checked=True,
                liveness_ok=False,
                liveness_reason=liveness_reason,
                error=liveness_reason,
            )

    frontales = [fd for fd in faces if abs(fd[1]["yaw"]) <= FRONTAL_YAW]
    if req.frontal_only:
        # Alta de frente: la plantilla no mezcla perfiles (6-09). Si casi no hay
        # cuadros de frente se dice ya, con la persona todavía ante la cámara.
        if len(frontales) < FRONTAL_MIN_FRAMES:
            return ExtractResponse(
                ok=False,
                faces_detected=len(faces),
                frontal_frames=len(frontales),
                liveness_checked=liveness_checked,
                liveness_ok=liveness_ok,
                error="Mira de frente a la cámara, sin girar la cabeza, y no te muevas un momento.",
            )
        faces = frontales

    # Embedding: al ENROLAR (aggregate) promediamos los cuadros válidos y
    # renormalizamos → plantilla menos sensible a un cuadro malo (luz/enfoque).
    # Al CHECAR usamos el cuadro más frontal (menor |yaw|).
    if req.aggregate and len(faces) > 1:
        vecs = np.array([f.normed_embedding for f, _ in faces], dtype=float)
        media = vecs.mean(axis=0)
        norma = float(np.linalg.norm(media))
        embedding = (media / norma if norma > 0 else media).astype(float).tolist()
    else:
        best_face, _ = min(faces, key=lambda fd: abs(fd[1]["yaw"]))
        embedding = best_face.normed_embedding.astype(float).tolist()

    return ExtractResponse(
        ok=True,
        embedding=embedding,
        faces_detected=len(faces),
        frontal_frames=len(frontales),
        liveness_checked=liveness_checked,
        liveness_ok=liveness_ok,
        liveness_reason=liveness_reason,
    )
