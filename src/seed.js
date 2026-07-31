/**
 * Generador de datos mock. Determinista (PRNG con semilla) para que dos corridas
 * produzcan exactamente el mismo dataset y los números sean comparables.
 *
 * Deja a propósito distribuciones desbalanceadas (una clínica grande, un médico
 * con agenda saturada, un tutor con muchos representados) porque los problemas
 * de un modelo single-table sólo aparecen cuando los datos NO son uniformes.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, recreateTable } from './schema.js';
import { K, G, norm, vpad, slotsFor, APPT_GROUP } from './keys.js';

// ---------- utilidades deterministas ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(20260730);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const id = (p, n) => `${p}${String(n).padStart(6, '0')}`;
const pad = (n) => String(n).padStart(2, '0');

const NOMBRES = ['Ana', 'José', 'María', 'Luis', 'Carmen', 'Miguel', 'Sofía', 'Diego', 'Lucía', 'Andrés', 'Valeria', 'Jorge', 'Patricia', 'Ricardo', 'Elena', 'Fernando', 'Gabriela', 'Roberto', 'Daniela', 'Alejandro'];
const APELLIDOS = ['González', 'Rodríguez', 'Pérez', 'Sánchez', 'Ramírez', 'Torres', 'Flores', 'Rivera', 'Gómez', 'Díaz', 'Cruz', 'Morales', 'Ortiz', 'Castillo', 'Núñez', 'Peña', 'Vargas', 'Mendoza', 'Herrera', 'Aguilar'];
const ESPECIALIDADES = ['Medicina general', 'Pediatría', 'Cardiología', 'Dermatología', 'Ginecología', 'Traumatología'];
const MOTIVOS = ['Consulta de control', 'Dolor abdominal', 'Cefalea persistente', 'Revisión de laboratorios', 'Seguimiento de tratamiento', 'Cuadro respiratorio'];
const LOREM = 'Paciente acude a consulta de seguimiento. Refiere mejoría parcial de la sintomatología descrita en la nota previa. A la exploración física se encuentra consciente, orientado, hidratado, con signos vitales dentro de parámetros esperados para su edad. Se ajusta el esquema terapéutico y se solicita control en dos semanas con estudios de laboratorio de rutina. Se explican datos de alarma al paciente y al acompañante, quienes refieren haber comprendido las indicaciones. ';

const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (base, n) => new Date(base.getTime() + n * 86400000);

// ---------- escritura por lotes ----------
/**
 * Acumula los items en memoria y los escribe al final con un pool acotado.
 * Es más simple que aplicar contrapresión en cada `put` y evita disparar
 * miles de peticiones en paralelo contra DynamoDB Local.
 */
class Writer {
  constructor(concurrency = 16) {
    // Map por PK|SK: en un modelo single-table dos generadores pueden producir
    // la misma clave (p. ej. dos signos vitales en el mismo instante). Deduplicar
    // aquí replica el comportamiento real de un PutItem y evita que BatchWrite
    // falle con "Provided list of item keys contains duplicates".
    this.map = new Map();
    this.concurrency = concurrency;
    this.bytes = 0;
    this.colisiones = 0;
  }
  get count() {
    return this.map.size;
  }
  put(item) {
    const k = `${item.PK}|${item.SK}`;
    if (this.map.has(k)) this.colisiones++;
    this.bytes += Buffer.byteLength(JSON.stringify(item));
    this.map.set(k, item);
  }
  async drain(onProgress = () => {}) {
    const items = [...this.map.values()];
    const batches = [];
    for (let i = 0; i < items.length; i += 25) {
      batches.push(items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })));
    }
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < batches.length) {
        let req = { RequestItems: { mediops: batches[next++] } };
        for (let attempt = 0; ; attempt++) {
          const r = await ddb.send(new BatchWriteCommand(req));
          const un = r.UnprocessedItems?.mediops;
          if (!un?.length) break;
          if (attempt >= 6) throw new Error('BatchWrite no pudo drenar los items pendientes');
          req = { RequestItems: { mediops: un } };
        }
        if (++done % 200 === 0) onProgress(`Escribiendo… ${done * 25}/${items.length} items`);
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
  }
}

export const SCALES = {
  small: { patients: 300, appointments: 1500, label: 'Pequeña (~15k items, ~10 s)' },
  medium: { patients: 1200, appointments: 8000, label: 'Media (~70k items, ~45 s)' },
  large: { patients: 4000, appointments: 30000, label: 'Grande (~250k items, ~3 min)' },
};

export async function seed({ scale = 'medium', onProgress = () => {} } = {}) {
  const cfg = SCALES[scale] ?? SCALES.medium;
  rnd = mulberry32(20260730);
  const t0 = Date.now();

  onProgress('Recreando tabla y GSIs…');
  await recreateTable();

  const w = new Writer();
  const today = new Date('2026-07-30T00:00:00Z');

  // ---------- clínicas: una grande y dos chicas, a propósito ----------
  const clinics = [
    { id: 'CLI001', nombre: 'Clínica Central', peso: 0.7 },
    { id: 'CLI002', nombre: 'Clínica Norte', peso: 0.2 },
    { id: 'CLI003', nombre: 'Clínica Sur', peso: 0.1 },
  ];
  const clinicFor = () => {
    const r = rnd();
    return r < 0.7 ? clinics[0] : r < 0.9 ? clinics[1] : clinics[2];
  };

  // ---------- personal ----------
  onProgress('Generando personal (médicos, recepción, enfermería, admin)…');
  const doctors = [];
  const staff = [];
  const mkUser = (n, rol, clinicIds, extra = {}) => {
    const userId = id('U', n);
    const nombre = pick(NOMBRES);
    const apellido = pick(APELLIDOS);
    const email = `${norm(nombre)}.${norm(apellido)}.${n}@mediops.test`;
    w.put({
      ...K.user(userId),
      ...G.gsi1Email(email),
      tipo: 'Usuario',
      userId,
      nombre: `${nombre} ${apellido}`,
      email,
      rol,
      estado: 'ACTIVO',
      creadoEn: isoDate(addDays(today, -int(30, 900))),
      ...extra,
    });
    w.put({
      ...K.credential(userId),
      tipo: 'Credencial',
      hash: '$2b$12$' + 'x'.repeat(53),
      algoritmo: 'bcrypt',
      intentosFallidos: 0,
      actualizadoEn: isoDate(addDays(today, -int(1, 400))),
    });
    if (rnd() < 0.4) {
      const sub = `1${String(int(10 ** 14, 10 ** 15 - 1))}`;
      w.put({ ...K.federated(userId, sub), ...G.gsi1Idp(sub), tipo: 'IdentidadFederada', userId, sub, idp: 'GOOGLE' });
      extra.googleSub = sub;
    }
    for (const c of clinicIds) {
      w.put({
        ...K.membership(userId, c),
        ...G.gsi1ClinicRole(c, rol, userId),
        tipo: 'Membresia',
        userId,
        clinicId: c,
        rol,
        activa: true,
        desde: isoDate(addDays(today, -int(30, 800))),
      });
    }
    return { userId, email, nombre: `${nombre} ${apellido}`, rol, clinicIds, googleSub: extra.googleSub };
  };

  let seq = 1;
  for (let i = 0; i < 30; i++) {
    // ~1/3 de los médicos opera en dos clínicas (D-01)
    const cs = rnd() < 0.33 ? [clinics[0].id, pick(clinics.slice(1)).id] : [clinicFor().id];
    const d = mkUser(seq++, 'MEDICO', cs, { especialidad: pick(ESPECIALIDADES), cedula: `CED${int(100000, 999999)}` });
    doctors.push(d);
  }
  for (const rol of ['RECEPCION', 'ENFERMERO', 'ADMIN']) {
    for (let i = 0; i < (rol === 'ADMIN' ? 3 : 9); i++) staff.push(mkUser(seq++, rol, [clinicFor().id]));
  }

  // ---------- pacientes ----------
  onProgress(`Generando ${cfg.patients} pacientes…`);
  const patients = [];
  for (let i = 0; i < cfg.patients; i++) {
    const patientId = id('P', i + 1);
    const clinic = clinicFor();
    const nombre = pick(NOMBRES);
    const apellido = pick(APELLIDOS);
    const nombreCompleto = `${nombre} ${apellido} ${pick(APELLIDOS)}`;
    const documento = `DOC${String(10000000 + i)}`;
    const e164 = `+52155${String(1000000 + i).slice(-7)}`;
    const p = {
      ...K.patient(patientId),
      ...G.gsi1Document(clinic.id, documento),
      GSI2PK: `CLINIC#${clinic.id}#PAT`,
      GSI2SK: `NAME#${norm(nombreCompleto)}`,
      tipo: 'Paciente',
      patientId,
      clinicId: clinic.id,
      nombre: nombreCompleto,
      nombreNormalizado: norm(nombreCompleto),
      documento,
      fechaNacimiento: `${int(1945, 2024)}-${pad(int(1, 12))}-${pad(int(1, 28))}`,
      sexo: pick(['F', 'M']),
      telefono: e164,
      email: `${norm(nombre)}${i}@correo.test`,
      direccion: `Calle ${pick(APELLIDOS)} ${int(1, 900)}, Col. ${pick(APELLIDOS)}`,
      alergias: rnd() < 0.3 ? [pick(['Penicilina', 'AINEs', 'Sulfas'])] : [],
      creadoEn: isoDate(addDays(today, -int(1, 900))),
    };
    w.put(p);
    w.put({ ...K.phone(e164, patientId), ...G.gsi1Phone(e164, 'PAT', patientId), tipo: 'Telefono', e164, ownerTipo: 'PAT', ownerId: patientId, verificado: true });
    patients.push({ patientId, clinicId: clinic.id, documento, e164, nombre: nombreCompleto });
  }

  // ---------- tutores (D-09, D-11) ----------
  onProgress('Vinculando tutores y representados…');
  const guardians = [];
  const nTutors = Math.max(20, Math.floor(cfg.patients * 0.15));
  for (let i = 0; i < nTutors; i++) {
    const g = mkUser(seq++, 'TUTOR', [clinicFor().id]);
    // el primer tutor recibe muchos representados: caso extremo para AP-21
    const n = i === 0 ? 12 : int(1, 3);
    const reps = [];
    for (let j = 0; j < n; j++) {
      const p = patients[int(0, patients.length - 1)];
      if (reps.includes(p.patientId)) continue;
      reps.push(p.patientId);
      w.put({
        ...K.guardianship(p.patientId, g.userId),
        ...G.gsi4Guardian(g.userId, p.patientId),
        tipo: 'Tutoria',
        patientId: p.patientId,
        guardianId: g.userId,
        parentesco: pick(['MADRE', 'PADRE', 'HIJO', 'CONYUGE', 'TUTOR_LEGAL']),
        vigenteDesde: isoDate(addDays(today, -int(30, 700))),
        activa: true,
      });
    }
    // teléfono del tutor: un mismo número apunta a varios pacientes (D-11)
    const e164 = `+52155${String(9000000 + i).slice(-7)}`;
    w.put({ ...K.phone(e164, g.userId), ...G.gsi1Phone(e164, 'TUTOR', g.userId), tipo: 'Telefono', e164, ownerTipo: 'TUTOR', ownerId: g.userId, verificado: true });
    guardians.push({ ...g, e164, representados: reps });
  }

  // ---------- disponibilidad ----------
  onProgress('Generando disponibilidad y bloqueos de médicos…');
  for (const d of doctors) {
    for (let k = -30; k <= 60; k++) {
      const day = addDays(today, k);
      if ([0, 6].includes(day.getUTCDay())) continue;
      const bloqueo = rnd() < 0.07;
      w.put({
        ...K.availability(d.userId, isoDate(day)),
        tipo: 'Disponibilidad',
        doctorId: d.userId,
        fecha: isoDate(day),
        bloques: bloqueo ? [] : [{ inicio: '09:00', fin: '14:00' }, { inicio: '16:00', fin: '19:00' }],
        bloqueo: bloqueo ? pick(['VACACIONES', 'QUIROFANO', 'CONGRESO']) : null,
      });
    }
  }

  // ---------- citas ----------
  onProgress(`Generando ${cfg.appointments} citas + slots + eventos…`);
  const appts = [];
  const busyDoctor = doctors[0];
  const busyDay = isoDate(addDays(today, 3));
  const takenSlots = new Set();

  for (let i = 0; i < cfg.appointments; i++) {
    // 8% de las citas se concentran en el médico/día saturado: partición caliente para AP-16
    const hot = rnd() < 0.08;
    const doctor = hot ? busyDoctor : doctors[int(0, doctors.length - 1)];
    const dayOffset = hot ? 3 : int(-30, 60);
    const day = addDays(today, dayOffset);
    if (!hot && [0, 6].includes(day.getUTCDay())) continue;
    const date = isoDate(day);
    const hhmm = `${pad(int(9, 18))}:${pad(pick([0, 15, 30, 45]))}`;
    const durMin = pick([15, 20, 30, 45, 60]);
    const buckets = slotsFor(hhmm, durMin);
    if (buckets.some((b) => takenSlots.has(`${doctor.userId}#${date}#${b}`))) continue;
    buckets.forEach((b) => takenSlots.add(`${doctor.userId}#${date}#${b}`));

    const apptId = id('A', i + 1);
    const patient = patients[int(0, patients.length - 1)];
    const startIso = `${date}T${hhmm}:00Z`;
    const pasada = dayOffset < 0;
    const estado = pasada ? pick(['ATENDIDA', 'ATENDIDA', 'ATENDIDA', 'NO_SHOW', 'CANCELADA']) : pick(['AGENDADA', 'AGENDADA', 'CONFIRMADA']);
    const grupo = pasada ? APPT_GROUP.DONE : APPT_GROUP.SCHED;
    const modalidad = rnd() < 0.2 ? 'REMOTA' : 'PRESENCIAL';
    const pendienteRecordatorio = !pasada && estado !== 'CANCELADA';

    w.put({
      ...K.appointment(apptId),
      ...G.gsi2DoctorDay(doctor.userId, date, hhmm, apptId),
      // GSI3 sparse: sólo mientras el recordatorio siga pendiente (AP-49 / AP-50)
      ...(pendienteRecordatorio ? G.gsi3Reminder(date, hhmm, apptId) : {}),
      tipo: 'Cita',
      apptId,
      doctorId: doctor.userId,
      patientId: patient.patientId,
      clinicId: patient.clinicId,
      fecha: date,
      hora: hhmm,
      inicioISO: startIso,
      duracionMin: durMin,
      estado,
      estadoGrupo: grupo,
      modalidad,
      salaId: modalidad === 'REMOTA' ? `sala-${apptId}` : undefined,
      motivo: pick(MOTIVOS),
      creadaPor: pick(staff).userId,
      creadaEn: isoDate(addDays(day, -int(1, 20))),
    });

    w.put({
      ...K.apptPatientView(patient.patientId, grupo, startIso),
      tipo: 'CitaVistaPaciente',
      apptId,
      patientId: patient.patientId,
      doctorId: doctor.userId,
      clinicId: patient.clinicId,
      inicioISO: startIso,
      duracionMin: durMin,
      estado,
      modalidad,
      motivo: pick(MOTIVOS),
    });

    for (const b of buckets) {
      w.put({ ...K.slot(doctor.userId, date, b), tipo: 'Slot', apptId, doctorId: doctor.userId, fecha: date, bucket: b });
    }

    const nEv = int(1, 3);
    for (let e = 0; e < nEv; e++) {
      const ts = new Date(day.getTime() - (nEv - e) * 3600000).toISOString();
      w.put({
        ...K.apptEvent(apptId, ts),
        tipo: 'EventoCita',
        apptId,
        ts,
        accion: e === 0 ? 'CREADA' : pick(['REPROGRAMADA', 'CONFIRMADA', 'ESTADO_CAMBIADO']),
        actorId: pick(staff).userId,
        desde: e === 0 ? null : 'AGENDADA',
        hacia: estado,
      });
    }

    if (pasada) {
      for (const canal of ['EMAIL', 'WHATSAPP']) {
        if (rnd() < 0.7) {
          w.put({
            ...K.notification(apptId, canal),
            tipo: 'Notificacion',
            apptId,
            canal,
            estado: pick(['ENVIADO', 'ENVIADO', 'LEIDO', 'FALLIDO']),
            intentos: int(1, 2),
            enviadoEn: new Date(day.getTime() - 86400000).toISOString(),
          });
        }
      }
    }
    appts.push({ apptId, doctorId: doctor.userId, patientId: patient.patientId, date, hhmm, estado, grupo, modalidad, clinicId: patient.clinicId });
  }

  // ---------- expediente: notas, signos vitales, recetas, permisos ----------
  onProgress('Generando notas versionadas, signos vitales, recetas y permisos…');
  const notesIdx = [];
  const grantsIdx = [];
  const seenPair = new Set();
  // pacientes que sí tienen cada relación: sin esto los patrones apuntan a
  // pacientes vacíos y el laboratorio reporta "sin datos" en vez de medir
  let patientConRecetas = null;
  let patientConVitales = null;
  let patientConCitasPasadas = null;

  for (const a of appts) {
    if (a.grupo !== APPT_GROUP.DONE || a.estado !== 'ATENDIDA') continue;
    const pairKey = `${a.doctorId}#${a.patientId}`;

    // permiso vigente médico↔paciente (AP-37 / AP-38)
    if (!seenPair.has(pairKey)) {
      seenPair.add(pairKey);
      w.put({
        ...K.grant(a.patientId, a.doctorId),
        ...G.gsi4DoctorPatient(a.doctorId, a.patientId),
        tipo: 'PermisoExpediente',
        patientId: a.patientId,
        doctorId: a.doctorId,
        clinicId: a.clinicId,
        estado: 'VIGENTE',
        origen: 'ATENCION',
        otorgadoEn: `${a.date}T${a.hhmm}:00Z`,
        vigenteHasta: isoDate(addDays(new Date(`${a.date}T00:00:00Z`), 365)),
      });
      grantsIdx.push({ patientId: a.patientId, doctorId: a.doctorId });
    }

    // nota clínica con versiones; sólo la última lleva GSI2 (índice sparse, AP-28)
    if (rnd() < 0.8) {
      const noteId = `N${a.apptId.slice(1)}`;
      const versiones = rnd() < 0.25 ? int(2, 4) : 1;
      const fechaIso = `${a.date}T${a.hhmm}:00Z`;
      for (let v = 1; v <= versiones; v++) {
        const vigente = v === versiones;
        w.put({
          ...K.note(a.patientId, noteId, v),
          ...(vigente ? G.gsi2CurrentNote(a.patientId, fechaIso) : {}),
          tipo: 'NotaClinica',
          patientId: a.patientId,
          noteId,
          version: v,
          vigente,
          apptId: a.apptId,
          autorId: a.doctorId,
          motivoEdicion: v === 1 ? null : pick(['Corrección de dosis', 'Se agrega hallazgo', 'Error de captura']),
          contenido: LOREM.repeat(int(1, 3)),
          creadaEn: new Date(new Date(fechaIso).getTime() + v * 60000).toISOString(),
        });
      }
      notesIdx.push({ patientId: a.patientId, noteId, versiones });
    }

    patientConCitasPasadas ??= a.patientId;

    // signos vitales (D-07 / HU-021)
    if (rnd() < 0.85) {
      const ts = `${a.date}T${a.hhmm}:00Z`;
      patientConVitales ??= a.patientId;
      w.put({
        ...K.vital(a.patientId, ts),
        tipo: 'SignoVital',
        patientId: a.patientId,
        ts,
        origen: 'ENFERMERIA',
        registradoPor: pick(staff.filter((s) => s.rol === 'ENFERMERO')).userId,
        ta: `${int(100, 140)}/${int(60, 90)}`,
        fc: int(55, 100),
        fr: int(12, 20),
        temp: (36 + rnd()).toFixed(1),
        spo2: int(94, 99),
        peso: (50 + rnd() * 45).toFixed(1),
      });
    }

    // recetas (HU-038, inmutables)
    if (rnd() < 0.5) {
      const ts = `${a.date}T${a.hhmm}:30Z`;
      const rxId = `RX${a.apptId.slice(1)}`;
      patientConRecetas ??= a.patientId;
      w.put({
        ...K.rx(a.patientId, ts, rxId),
        ...G.gsi2DoctorRx(a.doctorId, ts),
        tipo: 'Receta',
        rxId,
        patientId: a.patientId,
        doctorId: a.doctorId,
        clinicId: a.clinicId,
        emitidaEn: ts,
        estado: 'EMITIDA',
        leyenda: 'Documento informativo sin validez oficial',
        medicamentos: Array.from({ length: int(1, 3) }, () => ({
          nombre: pick(['Paracetamol 500mg', 'Ibuprofeno 400mg', 'Amoxicilina 875mg', 'Losartán 50mg', 'Metformina 850mg']),
          dosis: `1 tableta cada ${pick([8, 12, 24])} h`,
          duracion: `${int(3, 14)} días`,
        })),
      });
    }
  }

  // autorregistro de signos vitales del paciente (HU-022)
  for (const p of patients) {
    if (rnd() > 0.25) continue;
    for (let k = 0; k < int(3, 20); k++) {
      const ts = new Date(today.getTime() - k * 86400000 * int(1, 4)).toISOString();
      w.put({ ...K.vital(p.patientId, ts), tipo: 'SignoVital', patientId: p.patientId, ts, origen: 'PACIENTE', ta: `${int(105, 150)}/${int(65, 95)}`, fc: int(58, 105), peso: (50 + rnd() * 45).toFixed(1) });
    }
  }

  // ---------- pendientes: solicitudes, interconsultas, pánico (índices sparse GSI3) ----------
  onProgress('Generando pendientes (solicitudes, interconsultas, alertas)…');
  for (let i = 0; i < 60; i++) {
    const p = patients[int(0, patients.length - 1)];
    const d = doctors[int(0, doctors.length - 1)];
    const ts = new Date(today.getTime() - int(0, 10) * 86400000).toISOString();
    w.put({
      ...K.grant(p.patientId, d.userId),
      ...G.gsi3PendingGrant(p.clinicId, ts),
      tipo: 'PermisoExpediente',
      patientId: p.patientId,
      doctorId: d.userId,
      clinicId: p.clinicId,
      estado: 'PENDIENTE',
      solicitadoEn: ts,
      justificacion: 'Solicitud de acceso para atención de interconsulta',
    });
  }
  for (let i = 0; i < 40; i++) {
    const p = patients[int(0, patients.length - 1)];
    const destino = doctors[int(0, 5)];
    const ts = new Date(today.getTime() - int(0, 20) * 86400000).toISOString();
    const abierta = rnd() < 0.6;
    w.put({
      ...K.interconsult(p.patientId, ts, `IC${i}`),
      ...(abierta ? G.gsi3OpenInterconsult(destino.userId, ts) : {}),
      tipo: 'Interconsulta',
      icId: `IC${i}`,
      patientId: p.patientId,
      doctorOrigen: doctors[int(6, 29)].userId,
      doctorDestino: destino.userId,
      estado: abierta ? 'ABIERTA' : 'CERRADA',
      solicitadaEn: ts,
      conclusion: abierta ? null : 'Se sugiere continuar tratamiento y valorar en 30 días.',
    });
  }
  for (let i = 0; i < 25; i++) {
    const p = patients[int(0, patients.length - 1)];
    const ts = new Date(today.getTime() - int(0, 5) * 86400000).toISOString();
    const abierta = rnd() < 0.5;
    w.put({
      ...K.panic(p.patientId, ts),
      ...(abierta ? G.gsi3OpenPanic(p.clinicId, ts) : {}),
      tipo: 'AlertaPanico',
      patientId: p.patientId,
      clinicId: p.clinicId,
      ts,
      estado: abierta ? 'ABIERTA' : 'ATENDIDA',
      contexto: pick(['Dolor torácico', 'Caída', 'Crisis de ansiedad', 'Dificultad respiratoria']),
      atendidaPor: abierta ? null : pick(staff).userId,
      accionTomada: abierta ? null : 'Se contactó al paciente y se derivó a urgencias.',
    });
  }

  // ---------- auditoría y contadores ----------
  onProgress('Generando auditoría y contadores del dashboard…');
  const actors = [...doctors, ...staff, ...guardians];
  for (let i = 0; i < Math.floor(cfg.appointments * 1.5); i++) {
    // 25% de la auditoría la escribe un actor "SISTEMA": partición deliberadamente caliente
    const actor = rnd() < 0.25 ? { userId: 'SISTEMA' } : actors[int(0, actors.length - 1)];
    const day = addDays(today, -int(0, 60));
    const ts = new Date(day.getTime() + int(0, 86399) * 1000).toISOString();
    const clinicId = clinicFor().id;
    const eventId = id('E', i + 1);
    w.put({
      ...K.audit(actor.userId, ts, eventId),
      ...G.gsi4AuditClinicDay(clinicId, isoDate(day), ts, eventId),
      tipo: 'Auditoria',
      eventId,
      actorId: actor.userId,
      clinicId,
      ts,
      accion: pick(['LOGIN', 'CITA_CREADA', 'NOTA_CREADA', 'EXPEDIENTE_CONSULTADO', 'PERMISO_OTORGADO', 'RECETA_EMITIDA']),
      entidad: pick(['Cita', 'Paciente', 'NotaClinica', 'Receta']),
      entidadId: id('X', int(1, 5000)),
      ip: `189.${int(1, 254)}.${int(1, 254)}.${int(1, 254)}`,
    });
  }
  for (const c of clinics) {
    for (let k = 0; k < 90; k++) {
      const date = isoDate(addDays(today, -k));
      for (const m of ['CITAS_AGENDADAS', 'CITAS_ATENDIDAS', 'CITAS_CANCELADAS', 'NO_SHOW', 'PACIENTES_NUEVOS']) {
        w.put({ ...K.stat(c.id, date, m), tipo: 'ContadorDashboard', clinicId: c.id, fecha: date, metrica: m, valor: int(0, 120) });
      }
    }
  }

  onProgress(`Escribiendo ${w.count} items en DynamoDB Local…`);
  const itemCount = w.count;
  await w.drain(onProgress);

  // ---------- fixtures: identificadores reales para alimentar los patrones ----------
  const richPatient =
    notesIdx.length > 0
      ? patients.find((p) => p.patientId === notesIdx[0].patientId)
      : patients[0];
  const busyDayAppts = appts.filter((a) => a.doctorId === busyDoctor.userId && a.date === busyDay);
  const remDate = appts.find((a) => a.grupo === APPT_GROUP.SCHED)?.date ?? isoDate(addDays(today, 1));
  const bigGuardian = guardians[0];
  const sampleGrant = grantsIdx[0] ?? { patientId: richPatient.patientId, doctorId: doctors[0].userId };
  const patientWithAppts = appts.find((a) => a.grupo === APPT_GROUP.SCHED);

  const fixtures = {
    generadoEn: new Date().toISOString(),
    scale,
    segundos: +((Date.now() - t0) / 1000).toFixed(1),
    items: itemCount,
    bytesAprox: w.bytes,
    hoy: isoDate(today),
    clinicId: clinics[0].id,
    clinicIdChica: clinics[2].id,
    clinics: clinics.map((c) => c.id),
    // identidad
    email: doctors[0].email,
    userId: doctors[0].userId,
    googleSub: (doctors.find((d) => d.googleSub) ?? guardians.find((g) => g.googleSub))?.googleSub ?? null,
    rol: 'MEDICO',
    // médicos y agenda
    doctorId: busyDoctor.userId,
    doctorBusyDay: busyDay,
    doctorBusyDayCitas: busyDayAppts.length,
    doctorIdAlterno: doctors[1].userId,
    // pacientes
    patientId: richPatient.patientId,
    patientDocumento: richPatient.documento,
    patientClinicId: richPatient.clinicId,
    patientPhone: richPatient.e164,
    patientNombrePrefijo: norm(richPatient.nombre).slice(0, 4),
    patientConCitas: patientWithAppts?.patientId ?? richPatient.patientId,
    patientConCitasPasadas: patientConCitasPasadas ?? richPatient.patientId,
    patientConRecetas: patientConRecetas ?? richPatient.patientId,
    patientConVitales: patientConVitales ?? richPatient.patientId,
    patientConTutor: bigGuardian.representados[0] ?? richPatient.patientId,
    // tutores
    guardianId: bigGuardian.userId,
    guardianPhone: bigGuardian.e164,
    guardianRepresentados: bigGuardian.representados.length,
    // citas
    apptId: busyDayAppts[0]?.apptId ?? appts[0].apptId,
    apptIdRemota: appts.find((a) => a.modalidad === 'REMOTA')?.apptId ?? appts[0].apptId,
    remDate,
    // expediente
    noteId: notesIdx[0]?.noteId ?? null,
    notePatientId: notesIdx[0]?.patientId ?? richPatient.patientId,
    noteVersiones: notesIdx[0]?.versiones ?? 1,
    grantPatientId: sampleGrant.patientId,
    grantDoctorId: sampleGrant.doctorId,
    doctorConPacientes: grantsIdx[0]?.doctorId ?? doctors[0].userId,
    // pendientes
    panicClinicId: clinics[0].id,
    icDoctorId: doctors[0].userId,
    // auditoría
    auditActorId: 'SISTEMA',
    auditDate: isoDate(addDays(today, -1)),
    // sandbox para operaciones de escritura repetibles
    sandboxPatientId: patients[patients.length - 1].patientId,
    sandboxDoctorId: doctors[doctors.length - 1].userId,
    sandboxClinicId: clinics[0].id,
  };

  mkdirSync(new URL('../.lab/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../.lab/fixtures.json', import.meta.url), JSON.stringify(fixtures, null, 2));
  onProgress(`Listo: ${itemCount} items en ${fixtures.segundos}s`);
  return fixtures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const scale = process.argv[2] ?? 'medium';
  seed({ scale, onProgress: (m) => console.log('·', m) }).then((f) =>
    console.log(JSON.stringify(f, null, 2)),
  );
}
