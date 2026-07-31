/**
 * Los 57 patrones de acceso de `Patrones de acceso.md`, ejecutables.
 *
 * Cada patrón replica exactamente el índice y la clave que declara el documento.
 * Si un patrón resulta caro aquí, es el modelado el que hay que cambiar — no el patrón.
 *
 * Los patrones de escritura se ejecutan sobre entidades sandbox con id único por
 * corrida, para que puedan repetirse sin corromper el dataset ni fallar por condición.
 */
import { TABLE, K, G, norm, vpad, slotsFor, APPT_GROUP } from './keys.js';

let nonce = 0;
const uniq = () => `${Date.now().toString(36)}${(nonce++).toString(36)}`;
const T = TABLE;

/** Query helper: arma los params reduciendo el ruido en cada patrón. */
const q = ({ index, pk, pkName, sk, skName, ...rest }) => {
  const p = {
    TableName: T,
    ...(index ? { IndexName: index } : {}),
    KeyConditionExpression: sk ? `#pk = :pk AND ${sk}` : '#pk = :pk',
    // #sk sólo se declara si la condición realmente lo usa: DynamoDB rechaza
    // nombres declarados y no referenciados.
    ExpressionAttributeNames: { '#pk': pkName, ...(sk && skName ? { '#sk': skName } : {}) },
    ExpressionAttributeValues: { ':pk': pk, ...(rest.values ?? {}) },
    ...rest.extra,
  };
  delete p.values;
  return p;
};

const tablaQ = (pk, opts = {}) => q({ pkName: 'PK', pk, skName: 'SK', ...opts });
const gsiQ = (n, pk, opts = {}) =>
  q({ index: `GSI${n}`, pkName: `GSI${n}PK`, pk, skName: `GSI${n}SK`, ...opts });

export const GRUPOS = [
  'Autenticación e identidad',
  'Pacientes y tutores',
  'Citas',
  'Expediente, signos vitales y recetas',
  'Telemedicina, interconsultas y pánico',
  'Notificaciones y WhatsApp',
  'Dashboard y auditoría',
];

export const PATTERNS = [
  // ─────────────────────────── Autenticación e identidad ───────────────────────────
  {
    id: 'AP-01',
    grupo: GRUPOS[0],
    nombre: 'Obtener usuario por correo (login)',
    prioridad: 'Muy alta',
    op: 'Query',
    indice: 'GSI1',
    clave: 'GSI1PK = EMAIL#<email>',
    hu: ['HU-001'],
    run: (c) =>
      c.measure('Query', gsiQ(1, `EMAIL#${c.f.email}`, { extra: { Limit: 1 } }), { index: 'GSI1' }),
  },
  {
    id: 'AP-01b',
    grupo: GRUPOS[0],
    nombre: 'Obtener usuario por identidad Google',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'GSI1',
    clave: 'GSI1PK = IDP#GOOGLE#<sub>',
    hu: ['HU-001'],
    run: (c) =>
      c.measure('Query', gsiQ(1, `IDP#GOOGLE#${c.f.googleSub}`, { extra: { Limit: 1 } }), {
        index: 'GSI1',
      }),
    skip: (f) => (f.googleSub ? null : 'El dataset no generó identidades federadas'),
  },
  {
    id: 'AP-01c',
    grupo: GRUPOS[0],
    nombre: 'Obtener credencial del usuario',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'USER#<id> / CREDENTIAL',
    hu: ['HU-001'],
    run: (c) =>
      c.measure('GetItem', { TableName: T, Key: K.credential(c.f.userId), ConsistentRead: true }),
  },
  {
    id: 'AP-02',
    grupo: GRUPOS[0],
    nombre: 'Obtener perfil de usuario por ID',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'USER#<id> / PROFILE',
    hu: ['HU-001'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.user(c.f.userId) }),
  },
  {
    id: 'AP-03',
    grupo: GRUPOS[0],
    nombre: 'Listar clínicas/membresías de un usuario',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'Tabla',
    clave: "USER#<id>, begins_with(SK,'CLINIC#')",
    hu: ['HU-006'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`USER#${c.f.userId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'CLINIC#' },
        }),
      ),
  },
  {
    id: 'AP-04',
    grupo: GRUPOS[0],
    nombre: 'Registrar usuario',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'attribute_not_exists(PK) + ítem único de correo',
    hu: ['HU-004'],
    escritura: true,
    run: (c) => {
      const uid = `SBX${uniq()}`;
      const email = `sbx.${uid}@mediops.test`;
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: {
                ...K.user(uid),
                ...G.gsi1Email(email),
                tipo: 'Usuario',
                userId: uid,
                email,
                nombre: 'Paciente Sandbox',
                rol: 'PACIENTE',
                estado: 'ACTIVO',
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: T,
              Item: { PK: `UNIQ#EMAIL#${email}`, SK: 'UNIQ', tipo: 'Unicidad', userId: uid },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-05',
    grupo: GRUPOS[0],
    nombre: 'Listar usuarios por clínica y rol',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI1',
    clave: 'GSI1PK = CLINIC#<c>#ROLE#<rol>',
    hu: ['HU-007'],
    run: (c) => c.measure('Query', gsiQ(1, `CLINIC#${c.f.clinicId}#ROLE#MEDICO`), { index: 'GSI1' }),
  },
  {
    id: 'AP-06',
    grupo: GRUPOS[0],
    nombre: 'Cambiar rol / activar-desactivar membresía',
    prioridad: 'Baja',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'USER#<id> / CLINIC#<c>',
    hu: ['HU-006'],
    escritura: true,
    run: (c) =>
      c.measure('UpdateItem', {
        TableName: T,
        Key: K.membership(c.f.userId, c.f.clinicId),
        UpdateExpression: 'SET activa = :a, actualizadoEn = :t',
        ExpressionAttributeValues: { ':a': true, ':t': new Date().toISOString() },
      }),
  },

  // ─────────────────────────── Pacientes y tutores ───────────────────────────
  {
    id: 'AP-07',
    grupo: GRUPOS[1],
    nombre: 'Obtener paciente por ID (ficha)',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'PAT#<id> / PROFILE',
    hu: ['HU-008'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.patient(c.f.patientId) }),
  },
  {
    id: 'AP-08',
    grupo: GRUPOS[1],
    nombre: 'Buscar paciente por documento',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'GSI1',
    clave: 'GSI1PK = DOC#<clinicId>#<documento>',
    hu: ['HU-009'],
    run: (c) =>
      c.measure('Query', gsiQ(1, `DOC#${c.f.patientClinicId}#${c.f.patientDocumento}`), {
        index: 'GSI1',
      }),
  },
  {
    id: 'AP-09',
    grupo: GRUPOS[1],
    nombre: 'Buscar paciente por teléfono / correo',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'GSI1',
    clave: 'GSI1PK = PHONE#<e164>',
    hu: ['HU-009'],
    run: (c) => c.measure('Query', gsiQ(1, `PHONE#${c.f.patientPhone}`), { index: 'GSI1' }),
  },
  {
    id: 'AP-10',
    grupo: GRUPOS[1],
    nombre: 'Buscar paciente por prefijo de nombre',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI2',
    clave: "GSI2PK = CLINIC#<c>#PAT, begins_with(GSI2SK,'NAME#…')",
    hu: ['HU-010'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(2, `CLINIC#${c.f.patientClinicId}#PAT`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `NAME#${c.f.patientNombrePrefijo}` },
          extra: { Limit: 20 },
        }),
        { index: 'GSI2' },
      ),
  },
  {
    id: 'AP-11',
    grupo: GRUPOS[1],
    nombre: 'Registrar paciente',
    prioridad: 'Media-baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'perfil + ítem de unicidad de documento',
    hu: ['HU-008'],
    escritura: true,
    run: (c) => {
      const pid = `SBXP${uniq()}`;
      const doc = `DOCSBX${uniq()}`;
      const nombre = 'Paciente Sandbox Prueba';
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: {
                ...K.patient(pid),
                ...G.gsi1Document(c.f.clinicId, doc),
                ...G.gsi2PatientName(c.f.clinicId, norm(nombre)),
                tipo: 'Paciente',
                patientId: pid,
                clinicId: c.f.clinicId,
                nombre,
                documento: doc,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: T,
              Item: { PK: `UNIQ#DOC#${c.f.clinicId}#${doc}`, SK: 'UNIQ', tipo: 'Unicidad', patientId: pid },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-12',
    grupo: GRUPOS[1],
    nombre: 'Actualizar datos del paciente',
    prioridad: 'Media-baja',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'PAT#<id> / PROFILE',
    hu: ['HU-011'],
    escritura: true,
    run: (c) =>
      c.measure('UpdateItem', {
        TableName: T,
        Key: K.patient(c.f.sandboxPatientId),
        UpdateExpression: 'SET direccion = :d, actualizadoEn = :t',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: {
          ':d': `Calle Prueba ${nonce}`,
          ':t': new Date().toISOString(),
        },
      }),
  },
  {
    id: 'AP-13',
    grupo: GRUPOS[1],
    nombre: 'Listar representados de un tutor',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI4',
    clave: 'GSI4PK = GUARDIAN#<userId>',
    hu: ['HU-013'],
    run: (c) => c.measure('Query', gsiQ(4, `GUARDIAN#${c.f.guardianId}`), { index: 'GSI4' }),
  },
  {
    id: 'AP-14',
    grupo: GRUPOS[1],
    nombre: 'Listar tutores de un paciente',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "PAT#<id>, begins_with(SK,'GUARDIAN#')",
    hu: ['HU-012'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PAT#${c.f.patientConTutor}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'GUARDIAN#' },
        }),
      ),
  },
  {
    id: 'AP-15',
    grupo: GRUPOS[1],
    nombre: 'Vincular / revocar tutoría',
    prioridad: 'Baja',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'PAT#<id> / GUARDIAN#<u>',
    hu: ['HU-012'],
    escritura: true,
    run: (c) =>
      c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.guardianship(c.f.sandboxPatientId, c.f.guardianId),
          ...G.gsi4Guardian(c.f.guardianId, c.f.sandboxPatientId),
          tipo: 'Tutoria',
          patientId: c.f.sandboxPatientId,
          guardianId: c.f.guardianId,
          parentesco: 'TUTOR_LEGAL',
          activa: true,
        },
      }),
  },

  // ─────────────────────────── Citas ───────────────────────────
  {
    id: 'AP-16',
    grupo: GRUPOS[2],
    nombre: 'Agenda de un médico en un día',
    prioridad: 'Muy alta',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = DOC#<doctorId>#<YYYY-MM-DD>',
    hu: ['HU-029'],
    run: (c) =>
      c.measure('Query', gsiQ(2, `DOC#${c.f.doctorId}#${c.f.doctorBusyDay}`), { index: 'GSI2' }),
  },
  {
    id: 'AP-17',
    grupo: GRUPOS[2],
    nombre: 'Agenda de un médico en un rango (7 días)',
    prioridad: 'Alta',
    op: 'Query ×N',
    indice: 'GSI2',
    clave: 'una query por día',
    hu: ['HU-029'],
    fanout: true,
    run: async (c) => {
      const base = new Date(`${c.f.doctorBusyDay}T00:00:00Z`);
      for (let i = 0; i < 7; i++) {
        const d = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
        await c.measure('Query', gsiQ(2, `DOC#${c.f.doctorId}#${d}`), {
          index: 'GSI2',
          label: d,
          collect: i === 0,
        });
      }
      c.nota('7 peticiones para un rango de 7 días: el fan-out crece lineal con el rango.');
    },
  },
  {
    id: 'AP-18',
    grupo: GRUPOS[2],
    nombre: 'Detalle de una cita',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'APPT#<id> / META',
    hu: ['HU-028'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.appointment(c.f.apptId) }),
  },
  {
    id: 'AP-19',
    grupo: GRUPOS[2],
    nombre: 'Próximas citas de un paciente',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'Tabla',
    clave: "PAT#<id>, begins_with(SK,'APPT#SCHED#')",
    hu: ['HU-030'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PAT#${c.f.patientConCitas}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `APPT#${APPT_GROUP.SCHED}#` },
        }),
      ),
  },
  {
    id: 'AP-20',
    grupo: GRUPOS[2],
    nombre: 'Historial de citas pasadas',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: "PAT#<id>, SK between 'APPT#DONE#<desde>' and 'APPT#DONE#<hasta>'",
    hu: ['HU-031'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PAT#${c.f.patientConCitasPasadas}`, {
          sk: '#sk BETWEEN :a AND :b',
          values: {
            ':a': `APPT#${APPT_GROUP.DONE}#2020-01-01`,
            ':b': `APPT#${APPT_GROUP.DONE}#${c.f.hoy}`,
          },
        }),
      ),
  },
  {
    id: 'AP-21',
    grupo: GRUPOS[2],
    nombre: 'Agenda consolidada del tutor',
    prioridad: 'Media',
    op: 'AP-13 → AP-19 ×N',
    indice: 'GSI4 + Tabla',
    clave: 'fan-out en paralelo sobre los representados',
    hu: ['HU-032'],
    fanout: true,
    run: async (c) => {
      const reps = await c.measure('Query', gsiQ(4, `GUARDIAN#${c.f.guardianId}`), {
        index: 'GSI4',
        label: 'representados',
      });
      const ids = (reps.Items ?? []).map((i) => i.patientId);
      await Promise.all(
        ids.map((pid, idx) =>
          c.measure(
            'Query',
            tablaQ(`PAT#${pid}`, {
              sk: 'begins_with(#sk, :sk)',
              values: { ':sk': `APPT#${APPT_GROUP.SCHED}#` },
            }),
            { label: pid, collect: idx === 0 },
          ),
        ),
      );
      c.nota(
        `1 + ${ids.length} peticiones. El coste de esta pantalla lo fija el tutor con más representados, no el promedio.`,
      );
    },
  },
  {
    id: 'AP-22',
    grupo: GRUPOS[2],
    nombre: 'Crear cita sin traslape',
    prioridad: 'Media alta',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'SLOT#<doctorId>#<fecha>#<bucket15> con attribute_not_exists(PK)',
    hu: ['HU-025'],
    escritura: true,
    run: (c) => {
      const apptId = `SBXA${uniq()}`;
      // médico sandbox distinto en cada corrida: así el patrón es repetible y la
      // condición de traslape sólo falla cuando de verdad hay traslape.
      const doctorId = `SBXDOC${uniq()}`;
      const fecha = '2027-01-15';
      const hora = '09:00';
      const dur = 30;
      const startIso = `${fecha}T${hora}:00Z`;
      const buckets = slotsFor(hora, dur);
      return c.measure('TransactWriteItems', {
        TransactItems: [
          ...buckets.map((b) => ({
            Put: {
              TableName: T,
              Item: { ...K.slot(doctorId, fecha, b), tipo: 'Slot', apptId },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          })),
          {
            Put: {
              TableName: T,
              Item: {
                ...K.appointment(apptId),
                ...G.gsi2DoctorDay(doctorId, fecha, hora, apptId),
                ...G.gsi3Reminder(fecha, hora, apptId),
                tipo: 'Cita',
                apptId,
                doctorId,
                patientId: c.f.sandboxPatientId,
                clinicId: c.f.sandboxClinicId,
                fecha,
                hora,
                inicioISO: startIso,
                duracionMin: dur,
                estado: 'AGENDADA',
                estadoGrupo: APPT_GROUP.SCHED,
                modalidad: 'PRESENCIAL',
              },
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.apptPatientView(c.f.sandboxPatientId, APPT_GROUP.SCHED, startIso),
                tipo: 'CitaVistaPaciente',
                apptId,
                estado: 'AGENDADA',
              },
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.apptEvent(apptId, new Date().toISOString()),
                tipo: 'EventoCita',
                accion: 'CREADA',
              },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-23',
    grupo: GRUPOS[2],
    nombre: 'Reprogramar cita',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'libera slots viejos, reserva nuevos, actualiza cita, escribe EVT#',
    hu: ['HU-026'],
    escritura: true,
    run: async (c) => {
      // preparación silenciosa: una cita propia que sí se puede reprogramar
      const apptId = `SBXR${uniq()}`;
      const doctorId = `SBXDOC${uniq()}`;
      const fecha = '2027-02-10';
      const de = '08:00';
      const a = '11:00';
      const startOld = `${fecha}T${de}:00Z`;
      const startNew = `${fecha}T${a}:00Z`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.slot(doctorId, fecha, de), tipo: 'Slot', apptId },
      });
      await c.silent('PutItem', {
        TableName: T,
        Item: {
          ...K.appointment(apptId),
          ...G.gsi2DoctorDay(doctorId, fecha, de, apptId),
          tipo: 'Cita',
          apptId,
          doctorId,
          patientId: c.f.sandboxPatientId,
          fecha,
          hora: de,
          estado: 'AGENDADA',
        },
      });
      await c.silent('PutItem', {
        TableName: T,
        Item: {
          ...K.apptPatientView(c.f.sandboxPatientId, APPT_GROUP.SCHED, startOld),
          tipo: 'CitaVistaPaciente',
          apptId,
        },
      });

      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Delete: { TableName: T, Key: K.slot(doctorId, fecha, de) } },
          {
            Put: {
              TableName: T,
              Item: { ...K.slot(doctorId, fecha, a), tipo: 'Slot', apptId },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Update: {
              TableName: T,
              Key: K.appointment(apptId),
              UpdateExpression: 'SET hora = :h, inicioISO = :i, GSI2SK = :g',
              ExpressionAttributeValues: { ':h': a, ':i': startNew, ':g': `${a}#${apptId}` },
            },
          },
          // la vista del paciente lleva la hora en la SK: hay que borrar y reescribir
          {
            Delete: {
              TableName: T,
              Key: K.apptPatientView(c.f.sandboxPatientId, APPT_GROUP.SCHED, startOld),
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.apptPatientView(c.f.sandboxPatientId, APPT_GROUP.SCHED, startNew),
                tipo: 'CitaVistaPaciente',
                apptId,
              },
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.apptEvent(apptId, new Date().toISOString()),
                tipo: 'EventoCita',
                accion: 'REPROGRAMADA',
              },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-24',
    grupo: GRUPOS[2],
    nombre: 'Cancelar cita',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'libera slots, mueve SCHED→DONE, escribe EVT#',
    hu: ['HU-027'],
    escritura: true,
    run: async (c) => {
      const apptId = `SBXC${uniq()}`;
      const fecha = '2027-03-05';
      const hora = '10:00';
      const startIso = `${fecha}T${hora}:00Z`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.slot(c.f.sandboxDoctorId, fecha, hora), tipo: 'Slot', apptId },
      });
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.appointment(apptId), tipo: 'Cita', apptId, estado: 'AGENDADA' },
      });
      await c.silent('PutItem', {
        TableName: T,
        Item: {
          ...K.apptPatientView(c.f.sandboxPatientId, APPT_GROUP.SCHED, startIso),
          tipo: 'CitaVistaPaciente',
          apptId,
        },
      });

      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Delete: { TableName: T, Key: K.slot(c.f.sandboxDoctorId, fecha, hora) } },
          {
            Update: {
              TableName: T,
              Key: K.appointment(apptId),
              UpdateExpression: 'SET estado = :e, estadoGrupo = :g REMOVE GSI3PK, GSI3SK',
              ExpressionAttributeValues: { ':e': 'CANCELADA', ':g': APPT_GROUP.DONE },
            },
          },
          {
            Delete: {
              TableName: T,
              Key: K.apptPatientView(c.f.sandboxPatientId, APPT_GROUP.SCHED, startIso),
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.apptPatientView(c.f.sandboxPatientId, APPT_GROUP.DONE, startIso),
                tipo: 'CitaVistaPaciente',
                apptId,
                estado: 'CANCELADA',
              },
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.apptEvent(apptId, new Date().toISOString()),
                tipo: 'EventoCita',
                accion: 'CANCELADA',
                motivo: 'Prueba de laboratorio',
              },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-25',
    grupo: GRUPOS[2],
    nombre: 'Cambiar estado de la cita',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'APPT#<id> / META + EVT#<ts>',
    hu: ['HU-033'],
    escritura: true,
    run: (c) =>
      c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.appointment(c.f.apptId),
              UpdateExpression: 'SET estado = :e',
              ExpressionAttributeValues: { ':e': 'CONFIRMADA' },
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.apptEvent(c.f.apptId, new Date().toISOString()),
                tipo: 'EventoCita',
                accion: 'ESTADO_CAMBIADO',
                hacia: 'CONFIRMADA',
              },
            },
          },
        ],
      }),
  },
  {
    id: 'AP-26',
    grupo: GRUPOS[2],
    nombre: 'Historial de cambios de una cita',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: "APPT#<id>, begins_with(SK,'EVT#')",
    hu: ['HU-028'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`APPT#${c.f.apptId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'EVT#' },
        }),
      ),
  },
  {
    id: 'AP-27',
    grupo: GRUPOS[2],
    nombre: 'Disponibilidad / bloqueos de un médico',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'Tabla',
    clave: "DOC#<id>, begins_with(SK,'AVAIL#')",
    hu: ['HU-024'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`DOC#${c.f.doctorId}`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': `AVAIL#${c.f.hoy}`, ':b': 'AVAIL#2027-12-31' },
        }),
      ),
  },

  // ────────────────── Expediente, signos vitales y recetas ──────────────────
  {
    id: 'AP-28',
    grupo: GRUPOS[3],
    nombre: 'Listar notas vigentes de un paciente',
    prioridad: 'Media alta',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = PAT#<id>#NOTE, orden descendente',
    hu: ['HU-014'],
    run: (c) =>
      c.measure('Query', gsiQ(2, `PAT#${c.f.notePatientId}#NOTE`, { extra: { ScanIndexForward: false, Limit: 25 } }), {
        index: 'GSI2',
      }),
  },
  {
    id: 'AP-29',
    grupo: GRUPOS[3],
    nombre: 'Obtener versión vigente de una nota',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "PAT#<id>, begins_with(SK,'NOTE#<noteId>#'), Limit 1, desc",
    hu: ['HU-016'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PAT#${c.f.notePatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `NOTE#${c.f.noteId}#` },
          extra: { ScanIndexForward: false, Limit: 1 },
        }),
      ),
  },
  {
    id: 'AP-30',
    grupo: GRUPOS[3],
    nombre: 'Listar versiones de una nota',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: "PAT#<id>, begins_with(SK,'NOTE#<noteId>#')",
    hu: ['HU-017'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PAT#${c.f.notePatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `NOTE#${c.f.noteId}#` },
        }),
      ),
  },
  {
    id: 'AP-31',
    grupo: GRUPOS[3],
    nombre: 'Crear nota o nueva versión',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'escribe V<n+1> y quita GSI2PK de la versión anterior',
    hu: ['HU-016'],
    escritura: true,
    run: async (c) => {
      const noteId = `SBXN${uniq()}`;
      const pid = c.f.sandboxPatientId;
      const fecha = new Date().toISOString();
      await c.silent('PutItem', {
        TableName: T,
        Item: {
          ...K.note(pid, noteId, 1),
          ...G.gsi2CurrentNote(pid, fecha),
          tipo: 'NotaClinica',
          noteId,
          version: 1,
          vigente: true,
          contenido: 'Nota original de prueba.',
        },
      });
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.note(pid, noteId, 1),
              UpdateExpression: 'REMOVE GSI2PK, GSI2SK SET vigente = :f',
              ExpressionAttributeValues: { ':f': false },
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.note(pid, noteId, 2),
                ...G.gsi2CurrentNote(pid, fecha),
                tipo: 'NotaClinica',
                noteId,
                version: 2,
                vigente: true,
                motivoEdicion: 'Corrección de dosis',
                contenido: 'Nota corregida de prueba.',
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-32',
    grupo: GRUPOS[3],
    nombre: 'Registrar signo vital',
    prioridad: 'Media',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'PAT#<id> / VITAL#<ts>, origen ENFERMERIA/PACIENTE',
    hu: ['HU-021'],
    escritura: true,
    run: (c) =>
      c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.vital(c.f.sandboxPatientId, new Date().toISOString()),
          tipo: 'SignoVital',
          origen: 'ENFERMERIA',
          ta: '120/80',
          fc: 72,
          temp: '36.6',
          spo2: 98,
        },
      }),
  },
  {
    id: 'AP-33',
    grupo: GRUPOS[3],
    nombre: 'Serie de signos vitales por rango',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "PAT#<id>, SK between 'VITAL#<desde>' and 'VITAL#<hasta>'",
    hu: ['HU-023'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PAT#${c.f.patientConVitales}`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': 'VITAL#2020-01-01', ':b': 'VITAL#2099-12-31' },
        }),
      ),
  },
  {
    id: 'AP-34',
    grupo: GRUPOS[3],
    nombre: 'Emitir receta',
    prioridad: 'Media',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'PAT#<id> / RX#<ts>#<rxId>, inmutable',
    hu: ['HU-038'],
    escritura: true,
    run: (c) => {
      const ts = new Date().toISOString();
      const rxId = `SBXRX${uniq()}`;
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.rx(c.f.sandboxPatientId, ts, rxId),
          ...G.gsi2DoctorRx(c.f.sandboxDoctorId, ts),
          tipo: 'Receta',
          rxId,
          estado: 'EMITIDA',
          leyenda: 'Documento informativo sin validez oficial',
          medicamentos: [{ nombre: 'Paracetamol 500mg', dosis: '1 cada 8 h', duracion: '5 días' }],
        },
        // inmutabilidad (D-12 / HU-038): nunca se sobrescribe una receta emitida
        ConditionExpression: 'attribute_not_exists(PK) OR attribute_not_exists(SK)',
      });
    },
  },
  {
    id: 'AP-35',
    grupo: GRUPOS[3],
    nombre: 'Listar recetas de un paciente',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "PAT#<id>, begins_with(SK,'RX#')",
    hu: ['HU-039'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PAT#${c.f.patientConRecetas}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'RX#' },
        }),
      ),
  },
  {
    id: 'AP-36',
    grupo: GRUPOS[3],
    nombre: 'Listar recetas emitidas por un médico',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = DOC#<id>#RX por rango de fecha',
    hu: ['HU-040'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(2, `DOC#${c.f.doctorConPacientes}#RX`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': '2020-01-01', ':b': '2099-12-31' },
        }),
        { index: 'GSI2' },
      ),
  },
  {
    id: 'AP-37',
    grupo: GRUPOS[3],
    nombre: 'Verificar permiso de un médico sobre un expediente',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'PAT#<id> / GRANT#<doctorId>',
    hu: ['HU-008', 'HU-018'],
    run: (c) =>
      c.measure('GetItem', {
        TableName: T,
        Key: K.grant(c.f.grantPatientId, c.f.grantDoctorId),
        ConsistentRead: true,
      }),
  },
  {
    id: 'AP-38',
    grupo: GRUPOS[3],
    nombre: 'Listar pacientes de un médico',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'GSI4',
    clave: 'GSI4PK = DOC#<doctorId>',
    hu: ['HU-014'],
    run: (c) => c.measure('Query', gsiQ(4, `DOC#${c.f.doctorConPacientes}`), { index: 'GSI4' }),
  },
  {
    id: 'AP-39',
    grupo: GRUPOS[3],
    nombre: 'Solicitar acceso a expediente',
    prioridad: 'Media',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'GRANT# en estado PENDIENTE + GSI3PK = REQ#<clinicId>',
    hu: ['HU-018'],
    escritura: true,
    run: (c) => {
      const ts = new Date().toISOString();
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.grant(c.f.sandboxPatientId, c.f.sandboxDoctorId),
          ...G.gsi3PendingGrant(c.f.sandboxClinicId, ts),
          tipo: 'PermisoExpediente',
          estado: 'PENDIENTE',
          solicitadoEn: ts,
          justificacion: 'Solicitud de prueba',
        },
      });
    },
  },
  {
    id: 'AP-40',
    grupo: GRUPOS[3],
    nombre: 'Listar solicitudes de acceso pendientes',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI3',
    clave: 'GSI3PK = REQ#<clinicId> (sparse)',
    hu: ['HU-019'],
    run: (c) => c.measure('Query', gsiQ(3, `REQ#${c.f.clinicId}`), { index: 'GSI3' }),
  },
  {
    id: 'AP-41',
    grupo: GRUPOS[3],
    nombre: 'Aprobar / revocar acceso',
    prioridad: 'Media',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'quita GSI3PK, fija vigenteHasta y TTL',
    hu: ['HU-019'],
    escritura: true,
    run: async (c) => {
      const ts = new Date().toISOString();
      await c.silent('PutItem', {
        TableName: T,
        Item: {
          ...K.grant(c.f.sandboxPatientId, c.f.sandboxDoctorId),
          ...G.gsi3PendingGrant(c.f.sandboxClinicId, ts),
          tipo: 'PermisoExpediente',
          estado: 'PENDIENTE',
        },
      });
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.grant(c.f.sandboxPatientId, c.f.sandboxDoctorId),
        UpdateExpression:
          'SET estado = :e, vigenteHasta = :v, expiraTTL = :ttl REMOVE GSI3PK, GSI3SK',
        ConditionExpression: 'estado = :pend',
        ExpressionAttributeValues: {
          ':e': 'VIGENTE',
          ':pend': 'PENDIENTE',
          ':v': '2027-12-31',
          ':ttl': Math.floor(Date.now() / 1000) + 365 * 86400,
        },
      });
    },
  },

  // ────────────────── Telemedicina, interconsultas y pánico ──────────────────
  {
    id: 'AP-42',
    grupo: GRUPOS[4],
    nombre: 'Obtener datos de la sala de videoconsulta',
    prioridad: 'Media',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'APPT#<id> / META (modalidad, salaId)',
    hu: ['HU-035'],
    run: (c) =>
      c.measure('GetItem', {
        TableName: T,
        Key: K.appointment(c.f.apptIdRemota),
        ProjectionExpression: 'modalidad, salaId, inicioISO, duracionMin, patientId, doctorId',
      }),
  },
  {
    id: 'AP-43',
    grupo: GRUPOS[4],
    nombre: 'Crear interconsulta',
    prioridad: 'Baja',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'PAT#<id> / IC#<ts>#<icId> + GSI3PK = IC#<doctorDestino>',
    hu: ['HU-036'],
    escritura: true,
    run: (c) => {
      const ts = new Date().toISOString();
      const icId = `SBXIC${uniq()}`;
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.interconsult(c.f.sandboxPatientId, ts, icId),
          ...G.gsi3OpenInterconsult(c.f.icDoctorId, ts),
          tipo: 'Interconsulta',
          icId,
          estado: 'ABIERTA',
          doctorDestino: c.f.icDoctorId,
        },
      });
    },
  },
  {
    id: 'AP-44',
    grupo: GRUPOS[4],
    nombre: 'Interconsultas abiertas de un médico',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI3',
    clave: 'GSI3PK = IC#<doctorId> (sparse)',
    hu: ['HU-037'],
    run: (c) => c.measure('Query', gsiQ(3, `IC#${c.f.icDoctorId}`), { index: 'GSI3' }),
  },
  {
    id: 'AP-45',
    grupo: GRUPOS[4],
    nombre: 'Cerrar interconsulta con conclusión',
    prioridad: 'Baja',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'quita GSI3PK',
    hu: ['HU-037'],
    escritura: true,
    run: async (c) => {
      const ts = new Date().toISOString();
      const icId = `SBXIC${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: {
          ...K.interconsult(c.f.sandboxPatientId, ts, icId),
          ...G.gsi3OpenInterconsult(c.f.icDoctorId, ts),
          tipo: 'Interconsulta',
          estado: 'ABIERTA',
        },
      });
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.interconsult(c.f.sandboxPatientId, ts, icId),
        UpdateExpression: 'SET estado = :e, conclusion = :c REMOVE GSI3PK, GSI3SK',
        ExpressionAttributeValues: { ':e': 'CERRADA', ':c': 'Conclusión de prueba.' },
      });
    },
  },
  {
    id: 'AP-46',
    grupo: GRUPOS[4],
    nombre: 'Registrar alerta de pánico',
    prioridad: 'Media',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'PAT#<id> / PANIC#<ts> + GSI3PK = PANIC#<clinicId>',
    hu: ['HU-041'],
    escritura: true,
    run: (c) => {
      const ts = new Date().toISOString();
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.panic(c.f.sandboxPatientId, ts),
          ...G.gsi3OpenPanic(c.f.panicClinicId, ts),
          tipo: 'AlertaPanico',
          estado: 'ABIERTA',
          contexto: 'Prueba de laboratorio',
        },
      });
    },
  },
  {
    id: 'AP-47',
    grupo: GRUPOS[4],
    nombre: 'Listar alertas abiertas de la clínica',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI3',
    clave: 'GSI3PK = PANIC#<clinicId> (sparse)',
    hu: ['HU-042'],
    run: (c) => c.measure('Query', gsiQ(3, `PANIC#${c.f.panicClinicId}`), { index: 'GSI3' }),
  },
  {
    id: 'AP-48',
    grupo: GRUPOS[4],
    nombre: 'Marcar alerta como atendida',
    prioridad: 'Media',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'quita GSI3PK',
    hu: ['HU-042'],
    escritura: true,
    run: async (c) => {
      const ts = new Date().toISOString();
      await c.silent('PutItem', {
        TableName: T,
        Item: {
          ...K.panic(c.f.sandboxPatientId, ts),
          ...G.gsi3OpenPanic(c.f.panicClinicId, ts),
          tipo: 'AlertaPanico',
          estado: 'ABIERTA',
        },
      });
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.panic(c.f.sandboxPatientId, ts),
        UpdateExpression: 'SET estado = :e, accionTomada = :a REMOVE GSI3PK, GSI3SK',
        ExpressionAttributeValues: { ':e': 'ATENDIDA', ':a': 'Contacto telefónico' },
      });
    },
  },

  // ────────────────── Notificaciones y WhatsApp ──────────────────
  {
    id: 'AP-49',
    grupo: GRUPOS[5],
    nombre: 'Citas pendientes de recordatorio para una fecha',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI3',
    clave: 'GSI3PK = REM#<YYYY-MM-DD> (sparse)',
    hu: ['HU-043'],
    run: (c) => c.measure('Query', gsiQ(3, `REM#${c.f.remDate}`), { index: 'GSI3' }),
  },
  {
    id: 'AP-50',
    grupo: GRUPOS[5],
    nombre: 'Registrar resultado del envío',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'APPT#<id> / NOTIF#<canal> + quita GSI3PK de la cita',
    hu: ['HU-045'],
    escritura: true,
    run: (c) =>
      c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: {
                ...K.notification(c.f.apptId, 'WHATSAPP'),
                tipo: 'Notificacion',
                canal: 'WHATSAPP',
                estado: 'ENVIADO',
                enviadoEn: new Date().toISOString(),
              },
            },
          },
          {
            Update: {
              TableName: T,
              Key: K.appointment(c.f.apptId),
              UpdateExpression: 'REMOVE GSI3PK, GSI3SK',
            },
          },
        ],
      }),
  },
  {
    id: 'AP-51',
    grupo: GRUPOS[5],
    nombre: 'Resolver número de WhatsApp entrante',
    prioridad: 'Alta',
    op: 'Query (+ encadenado)',
    indice: 'GSI1 → GSI4',
    clave: 'GSI1PK = PHONE#<e164>; si es tutor, encadena AP-13',
    hu: ['HU-046'],
    fanout: true,
    run: async (c) => {
      const r = await c.measure('Query', gsiQ(1, `PHONE#${c.f.guardianPhone}`), {
        index: 'GSI1',
        label: 'teléfono',
      });
      const owner = r.Items?.[0];
      if (owner?.ownerTipo === 'TUTOR') {
        await c.measure('Query', gsiQ(4, `GUARDIAN#${owner.ownerId}`), {
          index: 'GSI4',
          label: 'representados',
        });
        c.nota('Número de tutor: 2 peticiones (teléfono → representados), como define D-11.');
      }
    },
  },
  {
    id: 'AP-52',
    grupo: GRUPOS[5],
    nombre: 'Próxima cita para responder por WhatsApp',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'Tabla',
    clave: "PAT#<id>, begins_with(SK,'APPT#SCHED#'), Limit 1",
    hu: ['HU-047'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PAT#${c.f.patientConCitas}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `APPT#${APPT_GROUP.SCHED}#` },
          extra: { Limit: 1 },
        }),
      ),
  },

  // ────────────────── Dashboard y auditoría ──────────────────
  {
    id: 'AP-53',
    grupo: GRUPOS[6],
    nombre: 'Registrar evento de auditoría',
    prioridad: 'Alta',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'AUD#<actorId> / <ts>#<eventId>',
    hu: ['HU-050'],
    escritura: true,
    run: (c) => {
      const ts = new Date().toISOString();
      const eventId = `SBXE${uniq()}`;
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.audit(c.f.userId, ts, eventId),
          ...G.gsi4AuditClinicDay(c.f.clinicId, ts.slice(0, 10), ts, eventId),
          tipo: 'Auditoria',
          eventId,
          accion: 'EXPEDIENTE_CONSULTADO',
          entidad: 'Paciente',
          entidadId: c.f.patientId,
        },
      });
    },
  },
  {
    id: 'AP-54',
    grupo: GRUPOS[6],
    nombre: 'Auditoría por actor y rango de fechas',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: 'AUD#<actorId>, SK between <desde> and <hasta>',
    hu: ['HU-051'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`AUD#${c.f.auditActorId}`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': '2026-01-01', ':b': '2027-01-01' },
        }),
      ),
  },
  {
    id: 'AP-55',
    grupo: GRUPOS[6],
    nombre: 'Auditoría por clínica y día',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI4',
    clave: 'GSI4PK = AUD#<clinicId>#<YYYY-MM-DD>',
    hu: ['HU-052'],
    run: (c) =>
      c.measure('Query', gsiQ(4, `AUD#${c.f.clinicId}#${c.f.auditDate}`), { index: 'GSI4' }),
  },
  {
    id: 'AP-56',
    grupo: GRUPOS[6],
    nombre: 'Incrementar contador',
    prioridad: 'Baja',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'STATS#<clinicId> / <fecha>#<metrica> (ADD, vía Streams)',
    hu: ['HU-049'],
    escritura: true,
    run: (c) =>
      c.measure('UpdateItem', {
        TableName: T,
        Key: K.stat(c.f.clinicId, c.f.hoy, 'CITAS_AGENDADAS'),
        UpdateExpression: 'ADD valor :uno',
        ExpressionAttributeValues: { ':uno': 1 },
      }),
  },
  {
    id: 'AP-57',
    grupo: GRUPOS[6],
    nombre: 'Leer indicadores del dashboard',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: 'STATS#<clinicId>, SK between <desde> and <hasta>',
    hu: ['HU-049'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`STATS#${c.f.clinicId}`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': '2026-05-01', ':b': '2026-12-31' },
        }),
      ),
  },
];

export const byId = Object.fromEntries(PATTERNS.map((p) => [p.id, p]));
