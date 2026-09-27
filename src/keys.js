/**
 * Constructores de clave — única fuente de verdad del modelado.
 * Refleja literalmente la tabla "Entidades y claves" de `Patrones de acceso.md`
 * (126 patrones, AP-01..AP-126, alineados con la Especificación maestra).
 *
 * Si el modelado cambia, se cambia aquí y todo el laboratorio queda consistente.
 */

export const TABLE = 'mediops';

/**
 * Nombre del atributo TTL. Tiene que ser UNO y estar declarado aquí: la tabla
 * desplegada nombraba `expiraTTL` mientras el código escribía `expiraEn`, así que
 * nada expiraba nunca. Es un fallo silencioso — ningún error, sólo ítems eternos.
 * Quien defina la tabla debe leer esta constante, no reescribir el literal.
 */
export const TTL_ATTR = 'expiraEn';

/** Normaliza para búsqueda por prefijo: sin acentos, minúsculas, sin dobles espacios. */
export const norm = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Correo normalizado: minúsculas y sin etiqueta +tag. */
export const normEmail = (s) => s.trim().toLowerCase().replace(/\+[^@]*(?=@)/, '');

/** Documento normalizado: sin separadores. */
export const normDoc = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Versión de nota con padding fijo: el orden lexicográfico es el orden numérico. */
export const vpad = (n) => `V#${String(n).padStart(5, '0')}`;

/**
 * Rejilla de reserva de 5 minutos (D-11). Más fina que la de 15 del modelo
 * anterior porque D-04 admite duración variable y una cita de 20 min no debe
 * bloquear 30. El coste es más ítems por transacción: ver `slotsFor`.
 */
export const SLOT_MIN = 5;

const hhmm = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** Todos los huecos de 5 min que ocupa una cita de `durMin` minutos desde `hhmmStart`. */
export const slotsFor = (hhmmStart, durMin) => {
  const [h, m] = hhmmStart.split(':').map(Number);
  const start = Math.floor((h * 60 + m) / SLOT_MIN) * SLOT_MIN;
  const end = h * 60 + m + durMin;
  const out = [];
  for (let t = start; t < end; t += SLOT_MIN) out.push(hhmm(t));
  return out;
};

/**
 * Grupo de estado con el que se ordena la vista de citas del paciente (GSI4).
 * Se recalcula en cada transición: es lo que separa AP-76 de AP-77.
 */
/**
 * Bucket mensual para las particiones que, si no, crecerían sin cota: la auditoría
 * de un actor automático y las colecciones por organización de notificaciones y
 * pagos. Lo detectó el propio laboratorio: `ORG#<org>#NOTIF` acumulaba más items
 * que ninguna otra partición del índice ya en la escala más pequeña.
 *
 * El mes es el punto medio: una consulta de seis meses son seis peticiones
 * paralelas (aceptable en accesos de baja prioridad), mientras que el día
 * dispararía el fan-out a 180.
 */
export const mesDe = (tsIso) => tsIso.slice(0, 7);

/** Meses (YYYY-MM) que cubre un rango de fechas ISO, para el fan-out de esas consultas. */
export const mesesEntre = (desdeIso, hastaIso) => {
  const out = [];
  let [y, m] = desdeIso.slice(0, 7).split('-').map(Number);
  const fin = hastaIso.slice(0, 7);
  for (let i = 0; i < 120; i++) {
    const cur = `${y}-${String(m).padStart(2, '0')}`;
    out.push(cur);
    if (cur >= fin) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
};

export const APPT_GROUP = { UPCOMING: 'UPCOMING', PAST: 'PAST' };

export const grupoDeEstado = (estado) =>
  ['PENDING_PAYMENT', 'CONFIRMED', 'IN_ROOM'].includes(estado)
    ? APPT_GROUP.UPCOMING
    : APPT_GROUP.PAST;

export const APPT_ESTADOS = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'IN_ROOM',
  'ATTENDED',
  'CANCELLED',
  'NO_SHOW',
];

export const PAY_ESTADOS = [
  'CREATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
];

export const K = {
  // ───────────────────────── identidad y sesión ─────────────────────────
  user: (userId) => ({ PK: `USER#${userId}`, SK: 'PROFILE' }),
  /** Guardián de unicidad: da unicidad real (un GSI no la impone) y resuelve el login en un GetItem. */
  uniqEmail: (emailNorm) => ({ PK: `UNIQ#EMAIL#${emailNorm}`, SK: 'USER' }),
  identity: (userId, sub) => ({ PK: `USER#${userId}`, SK: `IDENTITY#GOOGLE#${sub}` }),
  uniqIdp: (sub) => ({ PK: `UNIQ#IDP#GOOGLE#${sub}`, SK: 'USER' }),
  session: (userId, sessionId) => ({ PK: `USER#${userId}`, SK: `SESSION#${sessionId}` }),
  consent: (userId, tipo, version, tsIso) => ({
    PK: `USER#${userId}`,
    SK: `CONSENT#${tipo}#${version}#${tsIso}`,
  }),
  doctorProfile: (userId) => ({ PK: `USER#${userId}`, SK: 'DOCTOR_PROFILE' }),
  /** Estado del alta reanudable (HU-004a): ruta elegida, paso alcanzado. */
  onboarding: (userId) => ({ PK: `USER#${userId}`, SK: 'ONBOARDING' }),
  /** Reto de verificación de un contacto antes de indexarlo en GSI1 (HU-011a). */
  contactChallenge: (ownerPK, canal, valorNorm) => ({
    PK: ownerPK,
    SK: `CONTACTCHK#${canal}#${valorNorm}`,
  }),
  uniqLicense: (cedulaNorm) => ({ PK: `UNIQ#LICENSE#${cedulaNorm}`, SK: 'USER' }),
  /** El dueño puede ser un USER# (tutor) o un PATIENT#: la preferencia cuelga de quien consiente. */
  notifPref: (ownerPK) => ({ PK: ownerPK, SK: 'NOTIFPREF' }),

  // ───────────────────────── organización y membresía ─────────────────────────
  org: (organizationId) => ({ PK: `ORG#${organizationId}`, SK: 'PROFILE' }),
  capPolicy: (organizationId) => ({ PK: `ORG#${organizationId}`, SK: 'CAPPOLICY' }),
  governance: (organizationId) => ({ PK: `ORG#${organizationId}`, SK: 'GOVERNANCE' }),
  membership: (userId, organizationId) => ({
    PK: `USER#${userId}`,
    SK: `MEMBERSHIP#ORG#${organizationId}`,
  }),
  invite: (organizationId, inviteId) => ({
    PK: `ORG#${organizationId}`,
    SK: `INVITE#${inviteId}`,
  }),
  uniqInviteToken: (tokenHash) => ({ PK: `UNIQ#INVITE#${tokenHash}`, SK: 'ORG' }),
  /** Destinatarios configurados de la alerta de pánico (HU-041). */
  panicRecipients: (organizationId) => ({
    PK: `ORG#${organizationId}`,
    SK: 'PANICRECIPIENTS',
  }),
  /** Versión vigente del aviso de privacidad (HU-004b: puede exigir renovación). */
  privacyConfig: () => ({ PK: 'CONFIG#PRIVACY', SK: 'CURRENT' }),
  service: (organizationId, serviceId) => ({
    PK: `ORG#${organizationId}`,
    SK: `SERVICE#${serviceId}`,
  }),

  // ───────────────────────── paciente y representación ─────────────────────────
  patient: (patientId) => ({ PK: `PATIENT#${patientId}`, SK: 'PROFILE' }),
  enrollment: (patientId, organizationId) => ({
    PK: `PATIENT#${patientId}`,
    SK: `ENROLLMENT#ORG#${organizationId}`,
  }),
  /** Documento único **por organización**, no global (HU-008). */
  uniqPatientDoc: (organizationId, tipoDoc, docNorm) => ({
    PK: `UNIQ#PATDOC#${organizationId}#${tipoDoc}#${docNorm}`,
    SK: 'PATIENT',
  }),
  contact: (ownerPK, canal, valorNorm) => ({ PK: ownerPK, SK: `CONTACT#${canal}#${valorNorm}` }),
  uniqUserPatient: (userId) => ({ PK: `UNIQ#USERPATIENT#${userId}`, SK: 'PATIENT' }),
  guardian: (patientId, guardianUserId) => ({
    PK: `PATIENT#${patientId}`,
    SK: `GUARDIAN#USER#${guardianUserId}`,
  }),
  guardianEvent: (patientId, guardianUserId, tsIso) => ({
    PK: `PATIENT#${patientId}`,
    SK: `GUARDIANEVT#${guardianUserId}#${tsIso}`,
  }),
  mergedInto: (patientId) => ({ PK: `PATIENT#${patientId}`, SK: 'MERGEDINTO' }),
  /**
   * Puntero inverso. Sin él, desde el paciente canónico no hay forma de saber
   * qué identidades se consolidaron en él, y el expediente queda incompleto
   * tras un merge (HU-008c pide trazabilidad en ambos sentidos).
   */
  mergedFrom: (canonicoPatientId, origenPatientId) => ({
    PK: `PATIENT#${canonicoPatientId}`,
    SK: `MERGEDFROM#${origenPatientId}`,
  }),

  // ───────────────────────── expediente clínico ─────────────────────────
  note: (patientId, noteId, version) => ({
    PK: `PATIENT#${patientId}`,
    SK: `NOTE#${noteId}#${vpad(version)}`,
  }),
  attachment: (patientId, noteId, attachmentId) => ({
    PK: `PATIENT#${patientId}`,
    SK: `ATTACH#${noteId}#${attachmentId}`,
  }),
  /**
   * Clave determinista: un acceso vigente por (paciente, organización, médico).
   * AP-50 corre en cada operación clínica y tiene que ser un GetItem, no una Query.
   */
  access: (patientId, organizationId, doctorUserId) => ({
    PK: `PATIENT#${patientId}`,
    SK: `ACCESS#ORG#${organizationId}#DOCTOR#${doctorUserId}`,
  }),
  accessEvent: (patientId, tsIso, eventId) => ({
    PK: `PATIENT#${patientId}`,
    SK: `ACCESSEVT#${tsIso}#${eventId}`,
  }),
  vital: (patientId, tsIso, vitalId) => ({
    PK: `PATIENT#${patientId}`,
    SK: `VITAL#${tsIso}#${vitalId}`,
  }),

  // ───────────────────────── citas y telemedicina ─────────────────────────
  availRule: (organizationId, doctorUserId, ruleId) => ({
    PK: `ORG#${organizationId}#DOCTOR#${doctorUserId}`,
    SK: `AVAIL#RULE#${ruleId}`,
  }),
  availException: (organizationId, doctorUserId, date, blockId) => ({
    PK: `ORG#${organizationId}#DOCTOR#${doctorUserId}`,
    SK: `AVAIL#EXC#${date}#${blockId}`,
  }),
  appointment: (appointmentId) => ({ PK: `APPT#${appointmentId}`, SK: 'META' }),
  apptEvent: (appointmentId, tsIso, eventId) => ({
    PK: `APPT#${appointmentId}`,
    SK: `EVT#${tsIso}#${eventId}`,
  }),
  room: (appointmentId) => ({ PK: `APPT#${appointmentId}`, SK: 'ROOM' }),
  /** El ítem que hace atómica la reserva: se escribe con attribute_not_exists(PK). */
  slot: (organizationId, doctorUserId, date, bucket) => ({
    PK: `SLOT#${organizationId}#${doctorUserId}#${date}`,
    SK: bucket,
  }),
  referral: (patientId, tsIso, referralId) => ({
    PK: `PATIENT#${patientId}`,
    SK: `REFERRAL#${tsIso}#${referralId}`,
  }),

  // ───────────────────────── recetas ─────────────────────────
  rx: (patientId, tsIso, prescriptionId) => ({
    PK: `PATIENT#${patientId}`,
    SK: `RX#${tsIso}#${prescriptionId}`,
  }),
  uniqRxCode: (codigo) => ({ PK: `UNIQ#RXCODE#${codigo}`, SK: 'PATIENT' }),
  rxEvent: (patientId, prescriptionId, tsIso) => ({
    PK: `PATIENT#${patientId}`,
    SK: `RXEVT#${prescriptionId}#${tsIso}`,
  }),

  // ───────────────────────── pánico ─────────────────────────
  panic: (patientId, tsIso, alertId) => ({
    PK: `PATIENT#${patientId}`,
    SK: `PANIC#${tsIso}#${alertId}`,
  }),
  uniqPanic: (patientId, ventana) => ({ PK: `UNIQ#PANIC#${patientId}#${ventana}`, SK: 'PANIC' }),

  // ───────────────────────── notificaciones ─────────────────────────
  /** La clave idempotente deriva de (evento, destinatario, canal): el PutItem condicional es la deduplicación. */
  notification: (idempotencyKey) => ({ PK: `NOTIF#${idempotencyKey}`, SK: 'META' }),
  /**
   * Contexto de una conversación de WhatsApp. D-15 exige "contexto seleccionado"
   * y verificación proporcional al riesgo, y eso tiene que sobrevivir entre
   * mensajes en Lambdas sin estado. TTL corto: es sesión, no historial.
   */
  waConversation: (e164) => ({ PK: `WACONV#${e164}`, SK: 'STATE' }),

  // ───────────────────────── pagos ─────────────────────────
  paySettings: (organizationId) => ({ PK: `ORG#${organizationId}`, SK: 'PAYSETTINGS' }),
  payment: (paymentId) => ({ PK: `PAY#${paymentId}`, SK: 'META' }),
  /** Puntero: lista las órdenes de una cita sin gastar un GSI. */
  apptPayment: (appointmentId, paymentId) => ({
    PK: `APPT#${appointmentId}`,
    SK: `PAY#${paymentId}`,
  }),
  uniqProviderPay: (provider, providerPaymentId) => ({
    PK: `UNIQ#PROVIDERPAY#${provider}#${providerPaymentId}`,
    SK: 'PAY',
  }),
  uniqIdempPay: (idempotencyKey) => ({ PK: `UNIQ#IDEMP#PAY#${idempotencyKey}`, SK: 'PAY' }),
  // AP-139 · HU-003b: la clave la envía el cliente; se acota al usuario para que dos
  // personas no choquen con la misma clave.
  uniqIdempOrgCreate: (userId, idempotencyKey) => ({
    PK: `UNIQ#IDEMP#ORGCREATE#${userId}#${idempotencyKey}`,
    SK: 'ORG',
  }),
  webhookEvent: (provider, providerEventId) => ({
    PK: `WEBHOOK#${provider}#${providerEventId}`,
    SK: 'META',
  }),
  payEvent: (paymentId, tsIso, eventId) => ({
    PK: `PAY#${paymentId}`,
    SK: `EVT#${tsIso}#${eventId}`,
  }),
  refund: (paymentId, tsIso, refundId) => ({
    PK: `PAY#${paymentId}`,
    SK: `REFUND#${tsIso}#${refundId}`,
  }),

  // ───────────────────────── auditoría e indicadores ─────────────────────────
  /**
   * La organización va en la PK, no sólo como atributo: HU-051 limita la consulta
   * a las organizaciones donde el auditor tiene audit.read, y eso debe imponerlo
   * la clave. Si el recorte lo hace la aplicación, ya se leyeron eventos ajenos.
   * Los eventos sin tenant (login, cambio de contraseña) usan ORG_GLOBAL.
   * El bucket mensual evita que un actor automático llene una sola partición.
   */
  audit: (organizationId, actorUserId, tsIso, eventId) => ({
    PK: `AUDIT#ORG#${organizationId}#ACTOR#${actorUserId}#${mesDe(tsIso)}`,
    SK: `${tsIso}#${eventId}`,
  }),
  /** Bucket mensual, como AUDIT y las colecciones de GSI2: sin él crece sin fin. */
  stat: (organizationId, date, metrica) => ({
    PK: `STATS#${organizationId}#${date.slice(0, 7)}`,
    SK: `${date}#${metrica}`,
  }),
  /**
   * Agregado mensual, en partición ANUAL. Leer seis meses de detalle diario son
   * ~950 ítems: no es una partición caliente, es una respuesta enorme. El
   * dashboard lee el detalle diario de un mes y el agregado para los periodos
   * largos, y una sola consulta cubre el año entero.
   * El SK arranca por 'ROLLUP#' para no entrar en los BETWEEN por fecha.
   */
  statRollup: (organizationId, year, mes, metrica) => ({
    PK: `STATS#${organizationId}#ROLLUP#${year}`,
    SK: `${mes}#${metrica}`,
  }),
  /** Ocupación por médico (HU-049); vive en la misma partición mensual. */
  statDoctor: (organizationId, date, doctorUserId) => ({
    PK: `STATS#${organizationId}#${date.slice(0, 7)}`,
    SK: `${date}#OCUPACION#DOCTOR#${doctorUserId}`,
  }),
  /**
   * Marca de idempotencia del agregador (Streams puede reintregar un registro).
   * Vive en su propia partición: se escribe en CADA registro del stream y no debe
   * compartir capacidad con los contadores que se leen para el dashboard.
   */
  statSeen: (organizationId, eventId) => ({
    PK: `SEEN#${organizationId}#${eventId}`,
    SK: 'META',
  }),
};

/**
 * Claves de índice secundario. Un builder por acceso, con el mismo criterio que `K`:
 * el nombre dice qué patrón lo usa, no qué forma tiene.
 */
export const G = {
  // GSI1 · contactos verificados (la única búsqueda exacta que devuelve 1..N dueños)
  gsi1Contact: (canal, valorNorm, ownerRef) => ({
    GSI1PK: `CONTACT#${canal}#${valorNorm}`,
    GSI1SK: ownerRef,
  }),

  // GSI2 · series ordenadas por tiempo
  /**
   * Colecciones clínicas del paciente, SIEMPRE acotadas por organización.
   *
   * La consulta por tabla (`PATIENT#<p>`, begins_with 'VITAL#'/'RX#'/'REFERRAL#')
   * cruza tenants: un médico con acceso vigente en A vería lo registrado en B.
   * Las notas ya se acotaban así; vitales, recetas e interconsultas no, y era
   * una fuga real. El tipo va en la PK para poder segmentar por tipo y fecha,
   * que es lo que HU-014 admite explícitamente.
   */
  gsi2Clinico: (patientId, organizationId, tipo, tsIso, refId) => ({
    GSI2PK: `PATIENT#${patientId}#ORG#${organizationId}#${tipo}`,
    GSI2SK: `${tsIso}#${refId}`,
  }),
  gsi2CurrentNote: (patientId, organizationId, fechaIso, noteId) =>
    G.gsi2Clinico(patientId, organizationId, 'NOTE', fechaIso, noteId),
  gsi2Vital: (patientId, organizationId, tsIso, vitalId) =>
    G.gsi2Clinico(patientId, organizationId, 'VITAL', tsIso, vitalId),
  gsi2Rx: (patientId, organizationId, tsIso, prescriptionId) =>
    G.gsi2Clinico(patientId, organizationId, 'RX', tsIso, prescriptionId),
  gsi2Referral: (patientId, organizationId, tsIso, referralId) =>
    G.gsi2Clinico(patientId, organizationId, 'REFERRAL', tsIso, referralId),
  gsi2DoctorDay: (doctorUserId, organizationId, date, hora, appointmentId) => ({
    GSI2PK: `DOCTOR#${doctorUserId}#ORG#${organizationId}#${date}`,
    GSI2SK: `${hora}#${appointmentId}`,
  }),
  gsi2OrgNotif: (organizationId, tsIso, idempotencyKey) => ({
    GSI2PK: `ORG#${organizationId}#NOTIF#${mesDe(tsIso)}`,
    GSI2SK: `${tsIso}#${idempotencyKey}`,
  }),
  gsi2OrgPay: (organizationId, tsIso, paymentId) => ({
    GSI2PK: `ORG#${organizationId}#PAY#${mesDe(tsIso)}`,
    GSI2SK: `${tsIso}#${paymentId}`,
  }),

  // GSI3 · disperso, trabajo pendiente (al resolverse se borran las claves y el ítem sale del índice)
  gsi3MemberRequest: (organizationId, tsIso, userId) => ({
    GSI3PK: `MEMBERREQ#${organizationId}`,
    GSI3SK: `${tsIso}#${userId}`,
  }),
  gsi3AccessRequest: (organizationId, tsIso, patientId, doctorUserId) => ({
    GSI3PK: `ACCESSREQ#${organizationId}`,
    GSI3SK: `${tsIso}#${patientId}#${doctorUserId}`,
  }),
  /**
   * Acotado por organización, como el resto de bandejas. Sin el tenant era la
   * única colección verdaderamente global del modelo: todas las citas de todas
   * las organizaciones para una fecha, en una sola partición.
   */
  gsi3Reminder: (organizationId, date, hora, appointmentId) => ({
    GSI3PK: `REMINDER#${organizationId}#${date}`,
    GSI3SK: `${hora}#${appointmentId}`,
  }),
  gsi3Referral: (doctorDestinoUserId, tsIso, referralId) => ({
    GSI3PK: `REFERRAL#${doctorDestinoUserId}`,
    GSI3SK: `${tsIso}#${referralId}`,
  }),
  gsi3Panic: (organizationId, tsIso, alertId) => ({
    GSI3PK: `PANIC#${organizationId}`,
    GSI3SK: `${tsIso}#${alertId}`,
  }),
  gsi3PayPending: (organizationId, tsIso, paymentId) => ({
    GSI3PK: `PAYPENDING#${organizationId}`,
    GSI3SK: `${tsIso}#${paymentId}`,
  }),
  gsi3WebhookPending: (provider, tsIso, providerEventId) => ({
    GSI3PK: `WEBHOOKPENDING#${provider}`,
    GSI3SK: `${tsIso}#${providerEventId}`,
  }),

  // GSI4 · relaciones inversas y listados por organización
  gsi4OrgMember: (organizationId, operationalRole, status, userId) => ({
    GSI4PK: `ORG#${organizationId}#MEMBER`,
    GSI4SK: `${operationalRole}#${status}#${userId}`,
  }),
  /** El estado va delante del nombre: permite filtrar por ACTIVE y buscar por prefijo a la vez. */
  gsi4OrgPatient: (organizationId, status, nombreNorm, patientId) => ({
    GSI4PK: `ORG#${organizationId}#PATIENT`,
    GSI4SK: `${status}#NAME#${nombreNorm}#${patientId}`,
  }),
  gsi4Guardian: (guardianUserId, status, patientId) => ({
    GSI4PK: `GUARDIAN#${guardianUserId}`,
    GSI4SK: `${status}#PATIENT#${patientId}`,
  }),
  /** Recetas emitidas por un médico (AP-92). Vive en GSI4 desde que GSI2 pasó a ser el eje clínico del paciente. */
  gsi4DoctorRx: (doctorUserId, organizationId, tsIso, prescriptionId) => ({
    GSI4PK: `DOCTOR#${doctorUserId}#ORG#${organizationId}#RX`,
    GSI4SK: `${tsIso}#${prescriptionId}`,
  }),
  /** Invitaciones dirigidas a un correo (HU-007a: el invitado tiene que poder verlas). */
  gsi4InviteEmail: (emailNorm, estado, tsIso, inviteId) => ({
    GSI4PK: `INVITE#EMAIL#${emailNorm}`,
    GSI4SK: `${estado}#${tsIso}#${inviteId}`,
  }),
  gsi4DoctorPatients: (doctorUserId, organizationId, status, patientId) => ({
    GSI4PK: `DOCTOR#${doctorUserId}#ORG#${organizationId}`,
    GSI4SK: `${status}#PATIENT#${patientId}`,
  }),
  gsi4PatientAppt: (patientId, grupo, inicioIso, appointmentId) => ({
    GSI4PK: `PATIENT#${patientId}#APPT`,
    GSI4SK: `${grupo}#${inicioIso}#${appointmentId}`,
  }),
  gsi4Payer: (payerUserId, tsIso, paymentId) => ({
    GSI4PK: `PAYER#${payerUserId}`,
    GSI4SK: `${tsIso}#${paymentId}`,
  }),
  gsi4ApptNotif: (appointmentId, tsIso, canal) => ({
    GSI4PK: `APPT#${appointmentId}#NOTIF`,
    GSI4SK: `${tsIso}#${canal}`,
  }),
  gsi4AuditOrgDay: (organizationId, date, tsIso, eventId) => ({
    GSI4PK: `AUDIT#ORG#${organizationId}#${date}`,
    GSI4SK: `${tsIso}#${eventId}`,
  }),
};
