/**
 * Constructores de clave — única fuente de verdad del modelado.
 * Refleja literalmente la tabla "Entidades y claves" de `Patrones de acceso.md`.
 * Si el modelado cambia, se cambia aquí y todo el laboratorio queda consistente.
 */

export const TABLE = 'mediops';

/** Normaliza un nombre para búsqueda por prefijo: sin acentos, minúsculas, sin dobles espacios. */
export const norm = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Versión de nota con padding fijo para que el orden lexicográfico == orden numérico. */
export const vpad = (n) => `V${String(n).padStart(5, '0')}`;

/** Bucket de 15 min usado para la reserva atómica de huecos (AP-22). */
export const slotBucket = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${String(h).padStart(2, '0')}:${String(Math.floor(m / 15) * 15).padStart(2, '0')}`;
};

/** Todos los buckets de 15 min que ocupa una cita de `durMin` minutos desde `hhmm`. */
export const slotsFor = (hhmm, durMin) => {
  const [h, m] = hhmm.split(':').map(Number);
  const start = Math.floor((h * 60 + m) / 15) * 15;
  const end = h * 60 + m + durMin;
  const out = [];
  for (let t = start; t < end; t += 15) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
};

export const K = {
  user: (userId) => ({ PK: `USER#${userId}`, SK: 'PROFILE' }),
  credential: (userId) => ({ PK: `USER#${userId}`, SK: 'CREDENTIAL' }),
  federated: (userId, sub) => ({ PK: `USER#${userId}`, SK: `IDP#GOOGLE#${sub}` }),
  membership: (userId, clinicId) => ({ PK: `USER#${userId}`, SK: `CLINIC#${clinicId}` }),

  patient: (patientId) => ({ PK: `PAT#${patientId}`, SK: 'PROFILE' }),
  phone: (e164, userId) => ({ PK: `PHONE#${e164}`, SK: `OWNER#${userId}` }),
  guardianship: (patientId, userId) => ({ PK: `PAT#${patientId}`, SK: `GUARDIAN#${userId}` }),

  availability: (doctorId, date) => ({ PK: `DOC#${doctorId}`, SK: `AVAIL#${date}` }),
  appointment: (apptId) => ({ PK: `APPT#${apptId}`, SK: 'META' }),
  apptPatientView: (patientId, group, startIso) => ({
    PK: `PAT#${patientId}`,
    SK: `APPT#${group}#${startIso}`,
  }),
  apptEvent: (apptId, ts) => ({ PK: `APPT#${apptId}`, SK: `EVT#${ts}` }),
  slot: (doctorId, date, bucket) => ({ PK: `SLOT#${doctorId}#${date}#${bucket}`, SK: 'SLOT' }),

  note: (patientId, noteId, version) => ({
    PK: `PAT#${patientId}`,
    SK: `NOTE#${noteId}#${vpad(version)}`,
  }),
  vital: (patientId, tsIso) => ({ PK: `PAT#${patientId}`, SK: `VITAL#${tsIso}` }),
  rx: (patientId, tsIso, rxId) => ({ PK: `PAT#${patientId}`, SK: `RX#${tsIso}#${rxId}` }),
  grant: (patientId, doctorId) => ({ PK: `PAT#${patientId}`, SK: `GRANT#${doctorId}` }),
  interconsult: (patientId, tsIso, icId) => ({
    PK: `PAT#${patientId}`,
    SK: `IC#${tsIso}#${icId}`,
  }),
  panic: (patientId, tsIso) => ({ PK: `PAT#${patientId}`, SK: `PANIC#${tsIso}` }),
  notification: (apptId, canal) => ({ PK: `APPT#${apptId}`, SK: `NOTIF#${canal}` }),
  audit: (actorId, tsIso, eventId) => ({ PK: `AUD#${actorId}`, SK: `${tsIso}#${eventId}` }),
  stat: (clinicId, date, metric) => ({ PK: `STATS#${clinicId}`, SK: `${date}#${metric}` }),
};

/** Claves de índices secundarios, con el mismo criterio: un builder por acceso. */
export const G = {
  gsi1Email: (email) => ({ GSI1PK: `EMAIL#${email}`, GSI1SK: 'USER' }),
  gsi1Idp: (sub) => ({ GSI1PK: `IDP#GOOGLE#${sub}`, GSI1SK: 'USER' }),
  gsi1ClinicRole: (clinicId, rol, userId) => ({
    GSI1PK: `CLINIC#${clinicId}#ROLE#${rol}`,
    GSI1SK: `USER#${userId}`,
  }),
  gsi1Document: (clinicId, documento) => ({
    GSI1PK: `DOC#${clinicId}#${documento}`,
    GSI1SK: 'PAT',
  }),
  gsi1Phone: (e164, tipo, id) => ({ GSI1PK: `PHONE#${e164}`, GSI1SK: `${tipo}#${id}` }),

  gsi2PatientName: (clinicId, nombreNormalizado) => ({
    GSI2PK: `CLINIC#${clinicId}#PAT`,
    GSI2SK: `NAME#${nombreNormalizado}`,
  }),
  gsi2DoctorDay: (doctorId, date, hhmm, apptId) => ({
    GSI2PK: `DOC#${doctorId}#${date}`,
    GSI2SK: `${hhmm}#${apptId}`,
  }),
  gsi2CurrentNote: (patientId, fechaIso) => ({
    GSI2PK: `PAT#${patientId}#NOTE`,
    GSI2SK: fechaIso,
  }),
  gsi2DoctorRx: (doctorId, tsIso) => ({ GSI2PK: `DOC#${doctorId}#RX`, GSI2SK: tsIso }),

  gsi3Reminder: (date, hhmm, apptId) => ({ GSI3PK: `REM#${date}`, GSI3SK: `${hhmm}#${apptId}` }),
  gsi3PendingGrant: (clinicId, tsIso) => ({ GSI3PK: `REQ#${clinicId}`, GSI3SK: tsIso }),
  gsi3OpenInterconsult: (doctorId, tsIso) => ({ GSI3PK: `IC#${doctorId}`, GSI3SK: tsIso }),
  gsi3OpenPanic: (clinicId, tsIso) => ({ GSI3PK: `PANIC#${clinicId}`, GSI3SK: tsIso }),

  gsi4Guardian: (userId, patientId) => ({
    GSI4PK: `GUARDIAN#${userId}`,
    GSI4SK: `PAT#${patientId}`,
  }),
  gsi4DoctorPatient: (doctorId, patientId) => ({
    GSI4PK: `DOC#${doctorId}`,
    GSI4SK: `PAT#${patientId}`,
  }),
  gsi4AuditClinicDay: (clinicId, date, tsIso, eventId) => ({
    GSI4PK: `AUD#${clinicId}#${date}`,
    GSI4SK: `${tsIso}#${eventId}`,
  }),
};

/** Grupos de estado usados en la vista de citas del paciente (SK: APPT#<grupo>#<inicioISO>). */
export const APPT_GROUP = { SCHED: 'SCHED', DONE: 'DONE' };
