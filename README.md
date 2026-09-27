# Laboratorio de modelado DynamoDB · MEDI OPS

Banco de pruebas visual para validar el modelado single-table de
[`../Patrones de acceso.md`](../Patrones%20de%20acceso.md) **antes** de escribir la
aplicación: genera datos mock, ejecuta los 138 patrones de acceso reales contra
DynamoDB Local y muestra qué cuesta cada uno y dónde se rompe el modelo.

Alineado con la Especificación maestra (decisiones D-01..D-22, épicas 1..13,
historias HU-001..HU-071). El tenant es la **organización**, el rol vive en la
membresía y los pagos son parte del alcance.

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

| Escala | Pacientes | Citas | Items | Tiempo |
| :-- | --: | --: | --: | --: |
| `small` | 300 | 1 200 | ~29 000 | ~8 s |
| `medium` | 1 200 | 5 000 | ~88 000 | ~22 s |
| `large` | 4 000 | 18 000 | ~310 000 | ~90 s |

El contenedor arranca con `-Xmx2g`. Con el heap por defecto, sembrar la escala
media agota el timeout del SDK a media escritura: es una limitación de DynamoDB
Local sobre SQLite, no del modelo.

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
comparar AP-33 contra AP-72 en la misma máquina sí dice algo; el número absoluto no.

## Estructura

| Archivo | Rol |
| :-- | :-- |
| `src/keys.js` | Constructores de clave — **única fuente de verdad del modelado** |
| `src/schema.js` | Definición de tabla, los 4 GSIs y sus proyecciones; cliente apuntado a DynamoDB Local |
| `src/seed.js` | Generador determinista de datos mock, con distribuciones desbalanceadas a propósito |
| `src/patterns.js` | Los 138 patrones de acceso, ejecutables (AP-25 retirado) |
| `src/metrics.js` | Medición por petición: items, examinados, bytes, unidades |
| `src/runner.js` | Reglas de diagnóstico, prueba de carga y análisis de particiones |
| `src/server.js` | API + estáticos |
| `public/index.html` | Interfaz |

Si cambias el modelado, cambia `keys.js` y `patterns.js`; todo lo demás sigue.

## Las proyecciones de los GSIs son reales

`schema.js` declara las proyecciones que fija la sección 2.1 del documento, no
`ALL`. Con `ALL` cualquier consulta a un índice parece gratis y el laboratorio
dejaría de ver un coste que sí existe en producción: un índice ancho se paga en
almacenamiento y en WCU de **cada** escritura, y uno estrecho obliga a un segundo
salto a la tabla.

Por eso GSI1 es `KEYS_ONLY` y AP-32 y AP-105 aparecen con dos peticiones: el
índice resuelve al dueño del teléfono, y el detalle exige leer la tabla. Ese
salto es real y está medido, no escondido.

## Por qué los datos mock están desbalanceados

Un dataset uniforme hace que cualquier modelo se vea bien. El generador crea a
propósito los casos que rompen:

- **ORG001 concentra el 65% de los pacientes** — hace visible el coste de las
  colecciones por tenant (AP-33, AP-34).
- **Un médico con 120 citas el mismo día** — partición caliente en GSI2 (AP-72).
- **Un tutor con 12 representados** — el fan-out de AP-82 lo fija el peor caso, no el promedio.
- **Un actor `SISTEMA` que firma el 25% de la auditoría** — el caso que obligó a
  bucketizar `AUDIT#ACTOR#<actor>` por mes.
- **Médicos independientes con su propia `SOLO_PRACTICE`** — comprueba que D-04 no
  bifurca el modelo.
- **Solicitudes de membresía y de acceso en PENDING** — llenan las bandejas de GSI3
  para que AP-21 y AP-59 midan algo.

Las colisiones de clave que reporta el generador (`fixtures.colisiones`) son en su
mayoría items `SLOT#`: el día saturado produce citas que se solapan, algo que AP-75
rechazaría en producción. Aquí es deliberado, para que esa agenda sea densa de verdad.

## Reglas de diagnóstico

Cada patrón se evalúa contra reglas estructurales, no contra un umbral de tiempo:

| Regla | Nivel | Qué detecta |
| :-- | :-- | :-- |
| `scan` | Grave | El coste crece con la tabla, no con el resultado |
| `sobrelectura` | Grave | Examina mucho más de lo que devuelve |
| `paginacion` | Grave | Se truncó en 1 MB sin `Limit` explícito |
| `fanout-critico` | Grave | Un patrón de prioridad muy alta necesita más de una petición |
| `filtro` | Aviso | Usa `FilterExpression`: filtra después de leer |
| `fanout` | Aviso | Más de 3 peticiones para un patrón que no lo declara |
| `aislamiento` | Grave | Una consulta clínica sin `organizationId` en la clave: cruza tenants |
| `escritura-determinista` | Grave | Condición sobre clave determinista que bloquea la operación para siempre |
| `coleccion-grande` | Aviso | Devuelve >300 items sin cota superior |
| `sin-datos` | Aviso | La clave del patrón no existe en el dataset |

## Qué encontró el laboratorio

Dos rondas de auditoría sobre el modelado nuevo. La primera corrida detectó
cuatro particiones que crecían **sin cota**; una auditoría posterior encontró
otras tres, más una fuga entre organizaciones y tres condiciones que bloqueaban
una operación para siempre.

| Hallazgo | Corrección |
| :-- | :-- |
| `AUDIT#ACTOR#<actor>`, `ORG#<org>#NOTIF`, `ORG#<org>#PAY`, `STATS#<org>` crecían sin techo | Bucket temporal en la clave; la auditoría lleva además la organización |
| Signos vitales, recetas e interconsultas se consultaban sin `organizationId` | A GSI2 con `PATIENT#<p>#ORG#<o>#<TIPO>`, igual que las notas |
| `attribute_not_exists` sobre clave determinista en AP-20, AP-28 y AP-58 | La condición admite reescribir desde un estado terminal |
| El TTL de la tabla se llamaba `expiraTTL` y el código escribía `expiraEn` | Un solo nombre, `TTL_ATTR` en `keys.js` |
| Once accesos que las historias exigían sin estar declarados | AP-127..AP-138 |

Acotar por tenant no basta, y ésa fue la lección: `ORG#<org>#NOTIF` pertenece a
una sola organización y aun así no dejaba de crecer. Lo que distingue es si la
colección acumula **eventos** —que necesitan bucket temporal— o **entidades**,
acotadas por el tamaño del negocio.

Los hallazgos de aislamiento y de escritura condicional pasaron limpios la
primera corrida porque las reglas sólo miraban coste. Ahora hay tres más
(`aislamiento`, `escritura-determinista` y la detección de particiones sin cota),
y las excepciones legítimas se declaran con su motivo en `runner.js` en vez de
esconderse tras un patrón más permisivo.

Estado actual: **138 patrones, 137 sin hallazgos, 0 avisos, 1 omitido**
(AP-126 no toca DynamoDB), y ninguna partición sin cota.

## Sandbox de escritura

Los 54 patrones de escritura generan identificadores únicos por corrida, así que se
pueden repetir sin corromper el dataset ni fallar por condición. Cuando una
escritura necesita un estado previo concreto —una membresía `PENDING`, un pago sin
liquidar— se prepara con `c.silent()`, que no contamina la medición.

Van dejando items `SBX…` en la tabla; regenerar el dataset los limpia.
