# Laboratorio de modelado DynamoDB · MediOps

Banco de pruebas visual para validar el modelado single-table de
[`../Patrones de acceso.md`](../Patrones%20de%20acceso.md) **antes** de escribir la
aplicación: genera datos mock, ejecuta los 59 patrones de acceso reales contra
DynamoDB Local y muestra qué cuesta cada uno y dónde se rompe el modelo.

No toca AWS. Corre íntegramente contra DynamoDB Local en Docker con credenciales
falsas — la cuenta `mediops` (`185306267026`) nunca se usa aquí.

## Arranque

```bash
cd modeling-lab
npm install
npm run ddb:up          # DynamoDB Local en :8000 (Docker, en memoria)
npm start               # laboratorio en http://localhost:4000
```

En la interfaz: **Generar datos mock** → **Ejecutar los patrones** → **Analizar particiones**.

```bash
npm run seed -- medium  # sembrar desde la terminal (small | medium | large)
npm run ddb:down        # apagar y descartar los datos
```

El contenedor corre con `-inMemory`: al apagarlo se borra todo. Es lo que quieres
para un laboratorio — el dataset se regenera en segundos y es determinista.

## Qué mide y qué no

| Señal | ¿Vale para DynamoDB real? |
| :-- | :-- |
| Nº de peticiones (fan-out) | **Sí** — es propiedad del modelo, no del motor |
| Items examinados vs devueltos | **Sí** — se paga lo examinado, no lo devuelto |
| Bytes leídos → RCU/WCU estimadas | **Aproximado** — cálculo propio, 4 KB por RCU |
| Truncado a 1 MB / necesidad de paginar | **Sí** |
| Reparto de items por partición | **Sí** — delata particiones calientes |
| Latencia en ms | **No** — es SQLite local; sólo sirve para comparar patrones entre sí |

La latencia local no predice nada del servicio real. Está en la interfaz porque
comparar AP-10 contra AP-16 en la misma máquina sí dice algo; el número absoluto no.

## Estructura

| Archivo | Rol |
| :-- | :-- |
| `src/keys.js` | Constructores de clave — **única fuente de verdad del modelado** |
| `src/schema.js` | Definición de tabla y los 4 GSIs; cliente apuntado a DynamoDB Local |
| `src/seed.js` | Generador determinista de datos mock, con distribuciones desbalanceadas a propósito |
| `src/patterns.js` | Los 59 patrones de acceso, ejecutables |
| `src/metrics.js` | Medición por petición: items, examinados, bytes, unidades |
| `src/runner.js` | Reglas de diagnóstico, prueba de carga y análisis de particiones |
| `src/server.js` | API + estáticos |
| `public/index.html` | Interfaz |

Si cambias el modelado, cambia `keys.js` y `patterns.js`; todo lo demás sigue.

## Por qué los datos mock están desbalanceados

Un dataset uniforme hace que cualquier modelo se vea bien. El generador crea a
propósito los casos que rompen:

- **CLI001 concentra el 70% de los pacientes** — hace visible el coste de las
  colecciones por clínica (AP-10).
- **Un médico con la agenda saturada un día concreto** — partición caliente en GSI2 (AP-16).
- **Un tutor con 12 representados** — el fan-out de AP-21 lo fija el peor caso, no el promedio.
- **Un actor `SISTEMA` que firma el 25% de la auditoría** — partición de crecimiento ilimitado (AP-53/AP-54).

## Reglas de diagnóstico

Cada patrón se evalúa contra reglas estructurales, no contra un umbral de tiempo:

| Regla | Nivel | Qué detecta |
| :-- | :-- | :-- |
| `scan` | Grave | El coste crece con la tabla, no con el resultado |
| `sobrelectura` | Grave | Examina mucho más de lo que devuelve |
| `paginacion` | Grave | Se truncó en 1 MB sin `Limit` explícito |
| `fanout-critico` | Grave | Un patrón de prioridad muy alta necesita más de una petición |
| `filtro` | Aviso | Usa `FilterExpression`: filtra después de leer |
| `fanout` | Aviso | Más de 3 peticiones para un patrón |
| `coleccion-grande` | Aviso | Devuelve >300 items sin cota superior |
| `sin-datos` | Aviso | La clave del patrón no existe en el dataset |

## Sandbox de escritura

Los patrones de escritura (AP-04, AP-11, AP-22…) generan identificadores únicos por
corrida, así que se pueden repetir sin corromper el dataset ni fallar por condición.
Van dejando items `SBX…` en la tabla; regenerar el dataset los limpia.
