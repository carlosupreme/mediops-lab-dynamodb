/**
 * Generador de datos mock. Determinista (PRNG con semilla) para que dos corridas
 * produzcan exactamente el mismo dataset y los números sean comparables.
 *
 * Deja a propósito distribuciones desbalanceadas (una organización grande, un
 * médico con la agenda saturada, un tutor con muchos representados, un actor
 * automático que firma un cuarto de la auditoría) porque los problemas de un
 * modelo single-table sólo aparecen cuando los datos NO son uniformes.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, recreateTable } from './schema.js';
import {
  TABLE,
  K,
  G,
  norm,
  normEmail,
  normDoc,
  slotsFor,
  grupoDeEstado,
} from './keys.js';

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
let rnd = mulberry32(20260906);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = (p) => rnd() < p;
const id = (p, n) => `${p}${String(n).padStart(6, '0')}`;
const pad = (n) => String(n).padStart(2, '0');

const NOMBRES = ['Ana', 'José', 'María', 'Luis', 'Carmen', 'Miguel', 'Sofía', 'Diego', 'Lucía', 'Andrés', 'Valeria', 'Jorge', 'Patricia', 'Ricardo', 'Elena', 'Fernando', 'Gabriela', 'Roberto', 'Daniela', 'Alejandro'];
const APELLIDOS = ['González', 'Rodríguez', 'Pérez', 'Sánchez', 'Ramírez', 'Torres', 'Flores', 'Rivera', 'Gómez', 'Díaz', 'Cruz', 'Morales', 'Ortiz', 'Castillo', 'Núñez', 'Peña', 'Vargas', 'Mendoza', 'Herrera', 'Aguilar'];
const ESPECIALIDADES = ['Medicina general', 'Pediatría', 'Cardiología', 'Dermatología', 'Ginecología', 'Traumatología'];
const MOTIVOS = ['Consulta de control', 'Dolor abdominal', 'Cefalea persistente', 'Revisión de laboratorios', 'Seguimiento de tratamiento', 'Cuadro respiratorio'];
const METRICAS = ['CITAS_AGENDADAS', 'CITAS_ATENDIDAS', 'CITAS_CANCELADAS', 'NO_SHOW', 'PACIENTES_NUEVOS', 'PAGOS_CONFIRMADOS'];
const LOREM = 'Paciente acude a consulta de seguimiento. Refiere mejoría parcial de la sintomatología descrita en la nota previa. A la exploración física se encuentra consciente, orientado, hidratado, con signos vitales dentro de parámetros esperados para su edad. Se ajusta el esquema terapéutico y se solicita control en dos semanas con estudios de laboratorio de rutina. Se explican datos de alarma al paciente y al acompañante, quienes refieren haber comprendido las indicaciones. ';

const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (base, n) => new Date(base.getTime() + n * 86400000);
const tsOf = (date, hora = '09:00', seg = 0) => `${date}T${hora}:${pad(seg)}.000Z`;
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0').repeat(4);
};

// ---------- escritura por lotes ----------
/**
 * Acumula los items en memoria y los escribe al final con un pool acotado.
 * Deduplica por PK|SK: en single-table dos generadores pueden producir la misma
 * clave, y BatchWrite falla con "Provided list of item keys contains duplicates".
 */
class Writer {
  constructor(concurrency = 8) {
    // La mayoría de las colisiones que cuenta son items SLOT#: el día saturado
    // genera citas que se solapan, algo que AP-75 rechazaría en producción. Aquí
    // es deliberado — sirve para que la agenda de ese día sea densa de verdad.
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
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const worker = async () => {
      while (next < batches.length) {
        let req = { RequestItems: { [TABLE]: batches[next++] } };
        for (let attempt = 0; ; attempt++) {
          let r;
          try {
            r = await ddb.send(new BatchWriteCommand(req));
          } catch (e) {
            // DynamoDB Local corre sobre SQLite en una sola máquina y se satura
            // con decenas de miles de escrituras: devuelve ECONNRESET o timeout.
            // Es una limitación del laboratorio, no del modelo, así que se
            // reintenta con espera creciente en vez de tirar toda la siembra.
            const recuperable = ['TimeoutError', 'ECONNRESET', 'EPIPE'].some(
              (x) => e.name === x || e.code === x || String(e.message).includes(x),
            );
            if (!recuperable || attempt >= 8) throw e;
            await espera(150 * 2 ** attempt);
            continue;
          }
          const un = r.UnprocessedItems?.[TABLE];
          if (!un?.length) break;
          if (attempt >= 8) throw new Error('BatchWrite no pudo drenar los items pendientes');
          await espera(100 * 2 ** attempt);
          req = { RequestItems: { [TABLE]: un } };
        }
        if (++done % 200 === 0) onProgress(`Escribiendo… ${done * 25}/${items.length} items`);
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
  }
}

/**
 * La rejilla de reserva bajó de 15 a 5 minutos (D-04: duración variable), así que
 * una cita genera 3× más items SLOT# que en el modelo anterior. Bajamos el número
 * de citas para que el dataset siga cabiendo en el mismo orden de magnitud.
 */
export const SCALES = {
  small: { patients: 300, appointments: 1200, label: 'Pequeña (~27k items, ~8 s)' },
  medium: { patients: 1200, appointments: 5000, label: 'Media (~88k items, ~20 s)' },
  large: { patients: 4000, appointments: 18000, label: 'Grande (~310k items, ~80 s)' },
};

export async function seed({ scale = 'medium', onProgress = () => {} } = {}) {
  const cfg = SCALES[scale] ?? SCALES.medium;
  rnd = mulberry32(20260906);
  const t0 = Date.now();

  onProgress('Recreando tabla y GSIs…');
  await recreateTable();

  const w = new Writer();
  const today = new Date('2026-09-06T00:00:00Z');
  const hoy = isoDate(today);

  // ───────────────── organizaciones ─────────────────
  // Una grande, dos medianas y varias SOLO_PRACTICE (D-01, D-04). El desbalance
  // es intencional: hace visible el coste de las colecciones por tenant.
  onProgress('Generando organizaciones, capacidades y servicios…');
  const orgs = [
    { id: 'ORG001', nombre: 'Centro Médico Central', type: 'MEDICAL_CENTER', peso: 0.65 },
    { id: 'ORG002', nombre: 'Clínica Norte', type: 'CLINIC', peso: 0.2 },
    { id: 'ORG003', nombre: 'Clínica Sur', type: 'CLINIC', peso: 0.1 },
  ];
  for (let i = 0; i < 4; i++) {
    orgs.push({ id: id('ORG', 900 + i), nombre: `Consultorio independiente ${i + 1}`, type: 'SOLO_PRACTICE', peso: 0.0125, solo: true });
  }
  const orgFor = () => {
    const r = rnd();
    return r < 0.65 ? orgs[0] : r < 0.85 ? orgs[1] : r < 0.95 ? orgs[2] : pick(orgs.slice(3));
  };
  const servicesByOrg = {};
  for (const o of orgs) {
    w.put({
      ...K.org(o.id),
      tipo: 'Organizacion',
      organizationId: o.id,
      nombre: o.nombre,
      type: o.type,
      estado: 'ACTIVE',
      timezone: 'America/Mexico_City',
      mfaPolicy: o.type === 'SOLO_PRACTICE' ? 'OPCIONAL' : 'REQUERIDO_PERSONAL',
      creadoEn: isoDate(addDays(today, -int(200, 1200))),
    });
    // D-13: enfermería lee notas sólo si la organización se lo concede explícitamente.
    w.put({
      ...K.capPolicy(o.id),
      tipo: 'PoliticaCapacidades',
      organizationId: o.id,
      NURSE: chance(0.4) ? ['vitals.create', 'notes.read'] : ['vitals.create'],
      RECEPTIONIST: ['appointments.manage', 'patients.read'],
      DOCTOR: ['notes.write', 'notes.read', 'vitals.create', 'prescriptions.issue'],
    });
    w.put({ ...K.governance(o.id), tipo: 'Gobierno', organizationId: o.id, activeOwners: 1 });
    w.put({
      ...K.paySettings(o.id),
      tipo: 'ConfiguracionCobro',
      organizationId: o.id,
      provider: 'stripe',
      providerAccountId: `acct_${hash(o.id).slice(0, 16)}`,
      chargesEnabled: !o.solo || chance(0.5),
    });
    // HU-041: los destinatarios de la alerta no tenían ítem, sólo se invocaban.
    w.put({
      ...K.panicRecipients(o.id),
      tipo: 'DestinatariosPanico',
      organizationId: o.id,
      userIds: [],
      correos: [`urgencias@${o.id.toLowerCase()}.test`],
      avisarTutores: true,
    });
    servicesByOrg[o.id] = [];
    for (let s = 0; s < int(3, 5); s++) {
      const serviceId = id('SVC', int(1, 999999));
      const svc = {
        serviceId,
        duracionMin: pick([20, 30, 45, 60]),
        importe: pick([350, 500, 700, 900, 1200]),
        requierePago: chance(0.45),
      };
      servicesByOrg[o.id].push(svc);
      w.put({
        ...K.service(o.id, serviceId),
        tipo: 'Servicio',
        organizationId: o.id,
        nombre: pick(['Consulta general', 'Primera vez', 'Seguimiento', 'Teleconsulta', 'Control prenatal']),
        ...svc,
        moneda: 'MXN',
      });
    }
  }

  // HU-004b: hace falta poder leer cuál es la versión vigente para exigir renovación.
  w.put({
    ...K.privacyConfig(),
    tipo: 'ConfiguracionPrivacidad',
    version: 'v3',
    vigenteDesde: isoDate(addDays(today, -120)),
    exigeRenovacion: true,
    urlDocumento: 's3://mediops-legal/aviso-privacidad-v3.pdf',
  });

  // ───────────────── personal e identidades ─────────────────
  onProgress('Generando usuarios, identidades, sesiones y membresías…');
  let seq = 1;
  const allUsers = [];

  const mkUser = (rol, extra = {}) => {
    const userId = id('U', seq++);
    const nombre = pick(NOMBRES);
    const apellido = pick(APELLIDOS);
    const email = normEmail(`${norm(nombre)}.${norm(apellido)}.${userId}@mediops.test`);
    const estado = chance(0.03) ? 'SUSPENDED' : 'ACTIVE';
    const u = { userId, email, nombre: `${nombre} ${apellido}`, rol, estado, ...extra };

    w.put({
      ...K.user(userId),
      tipo: 'Usuario',
      userId,
      nombre: u.nombre,
      nombreNorm: norm(u.nombre),
      email,
      estado,
      activeOrganizationId: null,
      sessionsRevokedAt: null,
      mfaEnabled: chance(0.3),
      creadoEn: isoDate(addDays(today, -int(30, 900))),
    });
    // Guardián de unicidad: es lo que hace que AP-01 sea un GetItem y no una Query.
    w.put({ ...K.uniqEmail(email), tipo: 'GuardianCorreo', userId, email });

    if (chance(0.4)) {
      const sub = `1${String(int(10 ** 14, 10 ** 15 - 1))}`;
      u.googleSub = sub;
      w.put({ ...K.identity(userId, sub), tipo: 'IdentidadFederada', userId, sub, idp: 'GOOGLE', emailVerificado: true });
      w.put({ ...K.uniqIdp(sub), tipo: 'GuardianIdP', userId, sub });
    }
    // Sesiones vivas: el TTL es la baja natural, la revocación explícita no lo espera.
    u.sessions = [];
    for (let s = 0; s < int(1, 3); s++) {
      const sessionId = id('S', int(1, 999999));
      u.sessions.push(sessionId);
      w.put({
        ...K.session(userId, sessionId),
        tipo: 'Sesion',
        userId,
        sessionId,
        dispositivo: pick(['ios', 'android', 'web']),
        issuedAt: tsOf(isoDate(addDays(today, -int(0, 20))), '08:15'),
        expiraEn: Math.floor(addDays(today, int(1, 30)).getTime() / 1000),
      });
    }
    w.put({
      ...K.consent(userId, 'AVISO_PRIVACIDAD', 'v3', tsOf(isoDate(addDays(today, -int(10, 400))), '10:00')),
      tipo: 'Consentimiento',
      userId,
      version: 'v3',
      ip: `189.${int(1, 254)}.${int(1, 254)}.${int(1, 254)}`,
      mecanismo: 'CHECKBOX',
    });
    w.put({
      ...K.notifPref(`USER#${userId}`),
      tipo: 'PreferenciaNotificacion',
      userId,
      email: true,
      whatsapp: chance(0.7),
      consentimientoWhatsapp: chance(0.7),
    });
    // HU-004a: el alta es reanudable e idempotente, así que su estado tiene que
    // persistir. Una parte de los usuarios queda a medias a propósito.
    if (chance(0.15)) {
      w.put({
        ...K.onboarding(userId),
        tipo: 'Onboarding',
        userId,
        ruta: pick(['PACIENTE', 'REPRESENTANTE', 'PERSONAL_INVITADO', 'MEDICO_INDEPENDIENTE', 'MEDICO_SOLICITANTE']),
        paso: pick(['PERFIL', 'AVISO_PRIVACIDAD', 'ORGANIZACION']),
        estado: 'EN_CURSO',
        actualizadoEn: tsOf(isoDate(addDays(today, -int(0, 30))), '11:00'),
      });
      u.onboardingPendiente = true;
    }
    allUsers.push(u);
    return u;
  };

  const mkMembership = (u, organizationId, governanceRole, operationalRole, status = 'ACTIVE') => {
    const item = {
      ...K.membership(u.userId, organizationId),
      tipo: 'Membresia',
      userId: u.userId,
      organizationId,
      governanceRole,
      operationalRole,
      estado: status,
      nombre: u.nombre,
      desde: isoDate(addDays(today, -int(30, 800))),
      ...G.gsi4OrgMember(organizationId, operationalRole, status, u.userId),
    };
    // GSI3 es disperso: la solicitud sólo está en el índice mientras está PENDING.
    if (status === 'PENDING') {
      Object.assign(item, G.gsi3MemberRequest(organizationId, tsOf(isoDate(addDays(today, -int(1, 20))), '11:30'), u.userId));
      item.motivo = 'Solicitud de ingreso';
    }
    w.put(item);
    (u.orgs ??= []).push({ organizationId, governanceRole, operationalRole, status });
  };

  // médicos
  const doctors = [];
  for (let i = 0; i < 30; i++) {
    const cedula = `CED${int(100000, 999999)}`;
    const d = mkUser('DOCTOR', { cedula, especialidad: pick(ESPECIALIDADES) });
    w.put({
      ...K.doctorProfile(d.userId),
      tipo: 'PerfilMedico',
      userId: d.userId,
      cedula,
      especialidad: d.especialidad,
      verificacion: chance(0.8) ? 'VERIFICADA' : 'PENDIENTE',
    });
    w.put({ ...K.uniqLicense(normDoc(cedula)), tipo: 'GuardianCedula', userId: d.userId, cedula });

    if (i < 4) {
      // Médico independiente: SOLO_PRACTICE + OWNER/DOCTOR en una sola transacción (D-04).
      const o = orgs[3 + i];
      mkMembership(d, o.id, 'OWNER', 'DOCTOR');
      d.soloPracticeOrgId = o.id;
    } else {
      // ~1/3 opera en dos organizaciones (D-01).
      const primary = orgFor();
      mkMembership(d, primary.id, i === 4 ? 'OWNER' : 'MEMBER', 'DOCTOR');
      if (chance(0.33)) {
        const alt = orgs.find((o) => o.id !== primary.id && !o.solo);
        if (alt) mkMembership(d, alt.id, 'MEMBER', 'DOCTOR');
      }
    }
    doctors.push(d);
  }
  // Solicitudes de ingreso pendientes: alimentan la bandeja de AP-21.
  for (let i = 0; i < 6; i++) {
    const d = mkUser('DOCTOR', { especialidad: pick(ESPECIALIDADES) });
    mkMembership(d, orgs[0].id, 'MEMBER', 'DOCTOR', 'PENDING');
    doctors.push(d);
  }
  // Rechazados y dados de baja. Sin ellos el laboratorio no puede detectar que
  // una condición attribute_not_exists sobre clave determinista deja al
  // candidato sin poder volver a solicitar ingreso jamás.
  const rechazados = [];
  for (const estado of ['REJECTED', 'ENDED']) {
    for (let i = 0; i < 3; i++) {
      const d = mkUser('DOCTOR', { especialidad: pick(ESPECIALIDADES) });
      mkMembership(d, orgs[0].id, 'MEMBER', 'DOCTOR', estado);
      rechazados.push({ userId: d.userId, organizationId: orgs[0].id, estado });
    }
  }

  const staff = [];
  for (const [operationalRole, n] of [['NURSE', 9], ['RECEPTIONIST', 9], ['NONE', 4]]) {
    for (let i = 0; i < n; i++) {
      const u = mkUser(operationalRole);
      const o = orgFor();
      mkMembership(u, o.id, operationalRole === 'NONE' ? 'ADMIN' : 'MEMBER', operationalRole);
      staff.push(u);
    }
  }

  // invitaciones pendientes
  for (const o of orgs.slice(0, 3)) {
    for (let i = 0; i < 3; i++) {
      const inviteId = id('INV', int(1, 999999));
      const tokenHash = hash(`${o.id}:${inviteId}`).slice(0, 32);
      const correoInvitado = normEmail(`invitado.${inviteId}@mediops.test`);
      const tsInvite = tsOf(isoDate(addDays(today, -int(0, 5))), '09:00');
      w.put({
        ...K.invite(o.id, inviteId),
        ...G.gsi4InviteEmail(correoInvitado, 'PENDING', tsInvite, inviteId),
        tipo: 'Invitacion',
        organizationId: o.id,
        inviteId,
        governanceRole: 'MEMBER',
        operationalRole: pick(['DOCTOR', 'NURSE', 'RECEPTIONIST']),
        estado: 'PENDING',
        correo: correoInvitado,
        expiraEn: Math.floor(addDays(today, 7).getTime() / 1000),
      });
      if (!globalThis.__inviteEmail) globalThis.__inviteEmail = correoInvitado;
      w.put({ ...K.uniqInviteToken(tokenHash), tipo: 'GuardianInvitacion', organizationId: o.id, inviteId });
      if (!globalThis.__inviteToken) globalThis.__inviteToken = tokenHash;
    }
  }
  const inviteTokenHash = globalThis.__inviteToken;
  const inviteEmail = globalThis.__inviteEmail;
  delete globalThis.__inviteToken;
  delete globalThis.__inviteEmail;

  // ───────────────── pacientes, enrollments y contactos ─────────────────
  onProgress(`Generando ${cfg.patients} pacientes, asociaciones y contactos…`);
  const patients = [];
  for (let i = 0; i < cfg.patients; i++) {
    const patientId = id('P', i + 1);
    const nombre = `${pick(NOMBRES)} ${pick(APELLIDOS)} ${pick(APELLIDOS)}`;
    const nombreNorm = norm(nombre);
    const documento = `CURP${String(int(10 ** 9, 10 ** 10 - 1))}`;
    const e164 = `+52155${String(int(10 ** 7, 10 ** 8 - 1))}`;
    const correo = normEmail(`${nombreNorm.split(' ').join('.')}.${patientId}@correo.test`);

    // Un paciente puede estar en varias organizaciones sin duplicar identidad (D-05).
    const primary = orgFor();
    const enrolls = [primary.id];
    if (chance(0.18)) {
      const alt = orgs.find((o) => o.id !== primary.id && !o.solo);
      if (alt) enrolls.push(alt.id);
    }

    w.put({
      ...K.patient(patientId),
      tipo: 'Paciente',
      patientId,
      nombre,
      nombreNorm,
      documento,
      tipoDoc: 'CURP',
      nacimiento: `${int(1945, 2022)}-${pad(int(1, 12))}-${pad(int(1, 28))}`,
      sexo: pick(['F', 'M']),
      estado: 'ACTIVE',
      creadoEn: isoDate(addDays(today, -int(1, 900))),
    });

    for (const oid of enrolls) {
      const estado = chance(0.06) ? 'INACTIVE' : 'ACTIVE';
      w.put({
        ...K.enrollment(patientId, oid),
        tipo: 'Asociacion',
        patientId,
        organizationId: oid,
        estado,
        nombre,
        nombreNorm,
        desde: isoDate(addDays(today, -int(1, 800))),
        ...G.gsi4OrgPatient(oid, estado, nombreNorm, patientId),
      });
      // El documento es único POR organización, no global (HU-008).
      w.put({
        ...K.uniqPatientDoc(oid, 'CURP', normDoc(documento)),
        tipo: 'GuardianDocumento',
        patientId,
        organizationId: oid,
      });
    }

    // Contactos verificados: sólo se indexan en GSI1 tras verificar (HU-011a).
    for (const [canal, valor] of [['WHATSAPP', e164], ['EMAIL', correo]]) {
      w.put({
        ...K.contact(`PATIENT#${patientId}`, canal, valor),
        tipo: 'Contacto',
        patientId,
        canal,
        valor,
        verificado: true,
        ...G.gsi1Contact(canal, valor, `PATIENT#${patientId}`),
      });
    }
    w.put({
      ...K.notifPref(`PATIENT#${patientId}`),
      tipo: 'PreferenciaNotificacion',
      patientId,
      email: true,
      whatsapp: chance(0.75),
      consentimientoWhatsapp: chance(0.75),
    });

    patients.push({ patientId, nombre, nombreNorm, documento, e164, correo, orgs: enrolls, orgPrimary: primary.id });
  }

  // Un paciente consolidado en otro: HU-008c nunca es automático.
  const dupA = patients[patients.length - 1];
  const dupB = patients[patients.length - 2];
  w.put({
    ...K.mergedInto(dupA.patientId),
    tipo: 'Consolidacion',
    patientId: dupA.patientId,
    canonicoPatientId: dupB.patientId,
    estado: 'MERGED',
    motivo: 'Duplicado detectado por documento y teléfono',
  });
  // Puntero inverso: desde el canónico hay que poder enumerar sus orígenes, o el
  // expediente queda incompleto tras la consolidación.
  w.put({
    ...K.mergedFrom(dupB.patientId, dupA.patientId),
    tipo: 'OrigenConsolidado',
    patientId: dupB.patientId,
    origenPatientId: dupA.patientId,
    consolidadoEn: tsOf(hoy, '10:00'),
    actor: 'U000001',
  });

  // ───────────────── cuentas de paciente y tutores ─────────────────
  onProgress('Vinculando cuentas de paciente y relaciones de representación…');
  const linkedUsers = [];
  for (let i = 0; i < Math.min(120, Math.floor(cfg.patients * 0.25)); i++) {
    const u = mkUser('PATIENT');
    const p = patients[i];
    w.put({ ...K.uniqUserPatient(u.userId), tipo: 'VinculoCuentaExpediente', userId: u.userId, patientId: p.patientId });
    linkedUsers.push({ userId: u.userId, patientId: p.patientId, email: u.email });
  }

  const guardians = [];
  const mkGuardian = (representados) => {
    const u = mkUser('GUARDIAN');
    const e164 = `+52155${String(int(10 ** 7, 10 ** 8 - 1))}`;
    w.put({
      ...K.contact(`USER#${u.userId}`, 'WHATSAPP', e164),
      tipo: 'Contacto',
      userId: u.userId,
      canal: 'WHATSAPP',
      valor: e164,
      verificado: true,
      ...G.gsi1Contact('WHATSAPP', e164, `USER#${u.userId}`),
    });
    for (const p of representados) {
      const estado = chance(0.12) ? pick(['REVOKED', 'EXPIRED']) : 'ACTIVE';
      const ts = tsOf(isoDate(addDays(today, -int(10, 500))), '12:00');
      w.put({
        ...K.guardian(p.patientId, u.userId),
        tipo: 'Representacion',
        patientId: p.patientId,
        userId: u.userId,
        estado,
        relacion: pick(['MADRE', 'PADRE', 'TUTOR_LEGAL', 'HIJO']),
        // Los permisos se evalúan uno a uno; no existe un permiso genérico (HU-012a).
        viewAppointments: true,
        manageAppointments: chance(0.7),
        viewHistory: chance(0.5),
        viewPrescriptions: chance(0.6),
        receiveNotifications: chance(0.8),
        approveDoctorAccess: chance(0.3),
        vigenteHasta: isoDate(addDays(today, int(30, 900))),
        ...G.gsi4Guardian(u.userId, estado, p.patientId),
      });
      w.put({
        ...K.guardianEvent(p.patientId, u.userId, ts),
        tipo: 'EventoRepresentacion',
        patientId: p.patientId,
        userId: u.userId,
        accion: 'ALTA',
        actor: 'U000001',
        motivo: 'Alta inicial de representación',
      });
    }
    const g = { userId: u.userId, e164, representados: representados.map((p) => p.patientId) };
    guardians.push(g);
    return g;
  };

  // Un tutor con 12 representados: el fan-out de AP-82 lo fija el peor caso.
  const bigGuardian = mkGuardian(patients.slice(0, 12));
  for (let i = 0; i < 24; i++) {
    const base = int(12, Math.max(13, patients.length - 4));
    mkGuardian(patients.slice(base, base + int(1, 3)));
  }

  // D-15: la selección de representado y la verificación tienen que sobrevivir
  // entre mensajes; las Lambdas del bot no tienen estado.
  w.put({
    ...K.waConversation(bigGuardian.e164),
    tipo: 'ConversacionWhatsapp',
    e164: bigGuardian.e164,
    userId: bigGuardian.userId,
    patientIdSeleccionado: bigGuardian.representados[0],
    paso: 'CONTEXTO_ELEGIDO',
    verificadoHasta: tsOf(hoy, '23:59'),
    expiraEn: Math.floor(addDays(today, 1).getTime() / 1000),
  });

  // ───────────────── acceso médico-paciente ─────────────────
  onProgress('Generando accesos médico-paciente y su historial…');
  const accesses = [];
  const pendingAccesses = [];
  // Una terna (paciente, organización, médico) es una clave única: si la generamos
  // dos veces, la segunda pisa a la primera y los fixtures apuntan a un estado
  // que ya no existe en la tabla.
  const ternasVistas = new Set();
  for (const d of doctors.slice(0, 30)) {
    const om = (d.orgs ?? []).find((m) => m.estado !== 'PENDING') ?? d.orgs?.[0];
    if (!om) continue;
    const oid = om.organizationId;
    const candidatos = patients.filter((p) => p.orgs.includes(oid));
    if (!candidatos.length) continue;
    const n = Math.min(candidatos.length, int(8, 40));
    for (let i = 0; i < n; i++) {
      const p = candidatos[int(0, candidatos.length - 1)];
      const terna = `${p.patientId}|${oid}|${d.userId}`;
      if (ternasVistas.has(terna)) continue;
      ternasVistas.add(terna);
      const estado = chance(0.08) ? 'PENDING' : chance(0.1) ? 'EXPIRED' : chance(0.05) ? 'REVOKED' : 'ACTIVE';
      const ts = tsOf(isoDate(addDays(today, -int(0, 200))), `${pad(int(8, 19))}:${pad(int(0, 59))}`);
      const item = {
        ...K.access(p.patientId, oid, d.userId),
        tipo: 'AccesoMedicoPaciente',
        patientId: p.patientId,
        organizationId: oid,
        doctorUserId: d.userId,
        estado,
        source: pick(['CITA', 'CONSENTIMIENTO_PACIENTE', 'CONSENTIMIENTO_TUTOR', 'EXCEPCION_AUDITADA']),
        scope: pick(['COMPLETO', 'NOTAS', 'SIGNOS_VITALES']),
        expiresAt: isoDate(addDays(today, estado === 'EXPIRED' ? -int(1, 60) : int(10, 180))),
        tsISO: ts,
        ...G.gsi4DoctorPatients(d.userId, oid, estado, p.patientId),
      };
      // Sólo mientras está PENDING aparece en la bandeja del tenant (GSI3 disperso).
      if (estado === 'PENDING') {
        Object.assign(item, G.gsi3AccessRequest(oid, ts, p.patientId, d.userId));
        item.motivo = 'Solicitud de acceso para valoración';
        pendingAccesses.push({ patientId: p.patientId, organizationId: oid, doctorUserId: d.userId });
      }
      w.put(item);
      w.put({
        ...K.accessEvent(p.patientId, ts, id('AE', int(1, 999999))),
        tipo: 'EventoAcceso',
        patientId: p.patientId,
        organizationId: oid,
        doctorUserId: d.userId,
        accion: estado === 'PENDING' ? 'SOLICITADO' : 'OTORGADO',
        actor: d.userId,
        motivo: 'Atención clínica',
      });
      if (estado === 'ACTIVE') accesses.push({ patientId: p.patientId, organizationId: oid, doctorUserId: d.userId });
    }
  }

  // ───────────────── expediente: notas, adjuntos, signos vitales ─────────────────
  onProgress('Generando notas versionadas, adjuntos y signos vitales…');
  const notesIdx = [];
  let notaConAdjunto = null;
  const conNotas = accesses.slice(0, Math.min(accesses.length, Math.floor(cfg.patients * 0.6)));
  for (const a of conNotas) {
    for (let n = 0; n < int(1, 3); n++) {
      const noteId = id('N', int(1, 999999));
      const versiones = chance(0.35) ? int(2, 4) : 1;
      const base = addDays(today, -int(1, 400));
      for (let v = 1; v <= versiones; v++) {
        const fechaIso = tsOf(isoDate(addDays(base, v - 1)), `${pad(int(8, 19))}:${pad(int(0, 59))}`);
        const item = {
          ...K.note(a.patientId, noteId, v),
          tipo: 'NotaClinica',
          patientId: a.patientId,
          organizationId: a.organizationId,
          doctorUserId: a.doctorUserId,
          noteId,
          version: v,
          titulo: pick(MOTIVOS),
          contenido: LOREM.repeat(int(1, 3)),
          motivoEdicion: v > 1 ? 'Corrección de dosis indicada' : null,
          autor: a.doctorUserId,
          fecha: fechaIso,
        };
        // GSI2 disperso: sólo la versión vigente entra al expediente cronológico (AP-51).
        if (v === versiones) Object.assign(item, G.gsi2CurrentNote(a.patientId, a.organizationId, fechaIso, noteId));
        w.put(item);
      }
      if (chance(0.35)) {
        const attachmentId = id('AT', int(1, 999999));
        w.put({
          ...K.attachment(a.patientId, noteId, attachmentId),
          tipo: 'Adjunto',
          patientId: a.patientId,
          organizationId: a.organizationId,
          noteId,
          attachmentId,
          // El archivo vive en S3 privado; aquí sólo la referencia (D-10).
          s3Key: `org/${a.organizationId}/pat/${a.patientId}/${attachmentId}.pdf`,
          contentType: 'application/pdf',
          bytes: int(50_000, 4_000_000),
        });
        notaConAdjunto ??= { patientId: a.patientId, organizationId: a.organizationId, noteId };
      }
      notesIdx.push({ patientId: a.patientId, organizationId: a.organizationId, noteId, versiones });
    }
  }

  const conVitales = patients.slice(0, Math.floor(cfg.patients * 0.7));
  for (const p of conVitales) {
    for (let i = 0; i < int(2, 8); i++) {
      const ts = tsOf(isoDate(addDays(today, -int(0, 300))), `${pad(int(7, 20))}:${pad(int(0, 59))}`, int(0, 59));
      const vitalId = id('V', int(1, 999999));
      w.put({
        ...K.vital(p.patientId, ts, vitalId),
        ...G.gsi2Vital(p.patientId, p.orgPrimary, ts, vitalId),
        tipo: 'SignosVitales',
        patientId: p.patientId,
        organizationId: p.orgPrimary,
        vitalId,
        tsISO: ts,
        // El origen nunca se mezcla: una medición de enfermería no es un autorregistro.
        origin: pick(['NURSE', 'NURSE', 'DOCTOR', 'PATIENT']),
        mediciones: {
          fc: { valor: int(55, 110), unidad: 'lpm' },
          ta: { valor: `${int(95, 150)}/${int(60, 95)}`, unidad: 'mmHg' },
          temp: { valor: +(35.8 + rnd() * 2).toFixed(1), unidad: 'C' },
          spo2: { valor: int(92, 100), unidad: '%' },
        },
      });
    }
  }

  // ───────────────── disponibilidad ─────────────────
  onProgress('Generando disponibilidad y bloqueos…');
  for (const d of doctors) {
    for (const m of d.orgs ?? []) {
      if (m.estado === 'PENDING') continue;
      for (let dow = 1; dow <= 5; dow++) {
        w.put({
          ...K.availRule(m.organizationId, d.userId, `DOW${dow}`),
          tipo: 'ReglaDisponibilidad',
          organizationId: m.organizationId,
          doctorUserId: d.userId,
          diaSemana: dow,
          desde: '08:00',
          hasta: '18:00',
          timezone: 'America/Mexico_City',
        });
      }
      for (let e = 0; e < int(1, 4); e++) {
        const date = isoDate(addDays(today, int(-30, 60)));
        const blockId = id('B', int(1, 999999));
        w.put({
          ...K.availException(m.organizationId, d.userId, date, blockId),
          tipo: 'BloqueoDisponibilidad',
          organizationId: m.organizationId,
          doctorUserId: d.userId,
          fecha: date,
          desde: '13:00',
          hasta: '15:00',
          motivo: pick(['Congreso', 'Vacaciones', 'Quirófano', 'Personal']),
        });
      }
    }
  }

  // ───────────────── citas ─────────────────
  onProgress(`Generando ${cfg.appointments} citas, huecos e historial…`);
  const activeDoctors = doctors.filter((d) => (d.orgs ?? []).some((m) => m.estado !== 'PENDING'));
  const busyDoctor = activeDoctors[0];
  const busyOrg = busyDoctor.orgs.find((m) => m.estado !== 'PENDING').organizationId;
  const busyDay = isoDate(addDays(today, 3));
  const remDate = isoDate(addDays(today, 1));

  const appts = [];
  const paymentsSeed = [];
  for (let i = 0; i < cfg.appointments; i++) {
    const appointmentId = id('A', i + 1);
    // Un médico concentra la agenda de un día: partición caliente en GSI2 (AP-72).
    const saturada = i < 120;
    // Un lote cae en la fecha del recordatorio: sin esto la bandeja de AP-98
    // tenía 2 ítems y el patrón quedaba sin ejercitar de verdad.
    const paraRecordatorio = !saturada && i < 320;
    const d = saturada ? busyDoctor : pick(activeDoctors);
    const m = saturada
      ? { organizationId: busyOrg }
      : pick(d.orgs.filter((x) => x.estado !== 'PENDING'));
    const oid = m.organizationId;
    const candidatos = patients.filter((p) => p.orgs.includes(oid));
    const p = candidatos.length ? candidatos[int(0, candidatos.length - 1)] : patients[int(0, patients.length - 1)];

    const svc = pick(servicesByOrg[oid]);
    const fecha = saturada ? busyDay : paraRecordatorio ? remDate : isoDate(addDays(today, int(-120, 60)));
    const futura = fecha >= hoy;
    const hora = `${pad(int(8, 18))}:${pad(pick([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]))}`;
    const inicioISO = tsOf(fecha, hora);
    const duracionMin = svc.duracionMin;
    const modalidad = chance(0.18) ? 'REMOTE' : 'IN_PERSON';

    const estado = futura
      ? svc.requierePago && chance(0.35)
        ? 'PENDING_PAYMENT'
        : 'CONFIRMED'
      : pick(['ATTENDED', 'ATTENDED', 'ATTENDED', 'CANCELLED', 'NO_SHOW']);
    const grupo = grupoDeEstado(estado);

    const item = {
      ...K.appointment(appointmentId),
      tipo: 'Cita',
      appointmentId,
      organizationId: oid,
      patientId: p.patientId,
      doctorUserId: d.userId,
      serviceId: svc.serviceId,
      estado,
      inicioISO,
      fecha,
      hora,
      duracionMin,
      modalidad,
      motivo: pick(MOTIVOS),
      politicaPago: svc.requierePago ? 'REQUERIDO' : 'NO_REQUERIDO',
      importe: svc.importe,
      moneda: 'MXN',
      ...G.gsi2DoctorDay(d.userId, oid, fecha, hora, appointmentId),
      ...G.gsi4PatientAppt(p.patientId, grupo, inicioISO, appointmentId),
    };
    // El recordatorio sale del índice en cuanto se entrega: por eso GSI3 es disperso.
    if (fecha === remDate && estado === 'CONFIRMED') {
      Object.assign(item, G.gsi3Reminder(oid, fecha, hora, appointmentId));
      item.recordatorio = 'PENDIENTE';
    }
    w.put(item);

    // Huecos de 5 min: el ítem que hace atómica la reserva (AP-75).
    if (!['CANCELLED'].includes(estado)) {
      for (const b of slotsFor(hora, duracionMin)) {
        w.put({
          ...K.slot(oid, d.userId, fecha, b),
          tipo: 'HuecoReservado',
          organizationId: oid,
          doctorUserId: d.userId,
          appointmentId,
          fecha,
        });
      }
    }

    // Historial inmutable (D-11).
    let ev = 0;
    const evento = (accion, ts, extra = {}) =>
      w.put({
        ...K.apptEvent(appointmentId, ts, id('E', ++ev)),
        tipo: 'EventoCita',
        appointmentId,
        organizationId: oid,
        accion,
        actor: chance(0.5) ? d.userId : p.patientId,
        tsISO: ts,
        ...extra,
      });
    evento('CREADA', tsOf(isoDate(addDays(new Date(`${fecha}T00:00:00Z`), -int(1, 30))), '10:00'));
    if (chance(0.15)) evento('REPROGRAMADA', tsOf(fecha, '09:00'), { horarioAnterior: '08:00', motivo: 'Solicitud del paciente' });
    if (estado !== 'CONFIRMED' && estado !== 'PENDING_PAYMENT') evento(estado, tsOf(fecha, hora), { motivo: estado === 'CANCELLED' ? 'Cancelada por el paciente' : null });

    if (modalidad === 'REMOTE') {
      w.put({
        ...K.room(appointmentId),
        tipo: 'SalaVideoconsulta',
        appointmentId,
        organizationId: oid,
        proveedor: 'chime',
        roomId: `room_${hash(appointmentId).slice(0, 12)}`,
        ventanaDesde: inicioISO,
        ventanaHasta: tsOf(fecha, hora),
      });
    }

    if (svc.requierePago) paymentsSeed.push({ appointmentId, oid, p, svc, estado, fecha, doctorUserId: d.userId });
    appts.push({ appointmentId, organizationId: oid, patientId: p.patientId, doctorUserId: d.userId, fecha, hora, estado, modalidad, grupo });
  }

  // ───────────────── interconsultas ─────────────────
  onProgress('Generando interconsultas, recetas y alertas…');
  const referralDoctor = activeDoctors[1];
  let referralPatientId = null;
  let referralOrgId = null;
  for (let i = 0; i < 60; i++) {
    const a = pick(accesses.length ? accesses : [{ patientId: patients[0].patientId, organizationId: orgs[0].id, doctorUserId: doctors[0].userId }]);
    const destino = i < 15 ? referralDoctor : pick(activeDoctors);
    const estado = i < 20 ? 'PENDING' : pick(['ACCEPTED', 'CLOSED', 'REJECTED']);
    const ts = tsOf(isoDate(addDays(today, -int(0, 120))), `${pad(int(8, 19))}:${pad(int(0, 59))}`);
    const referralId = id('R', int(1, 999999));
    const item = {
      ...K.referral(a.patientId, ts, referralId),
      tipo: 'Interconsulta',
      patientId: a.patientId,
      organizationId: a.organizationId,
      doctorUserId: a.doctorUserId,
      destinoUserId: destino.userId,
      referralId,
      estado,
      tsISO: ts,
      motivo: 'Segunda opinión sobre hallazgo incidental',
      conclusion: estado === 'CLOSED' ? 'Se sugiere control en 3 meses' : null,
    };
    Object.assign(item, G.gsi2Referral(a.patientId, a.organizationId, ts, referralId));
    if (['PENDING', 'ACCEPTED'].includes(estado)) Object.assign(item, G.gsi3Referral(destino.userId, ts, referralId));
    w.put(item);
    if (referralPatientId === null) {
      referralPatientId = a.patientId;
      referralOrgId = a.organizationId;
    }
  }

  // ───────────────── recetas ─────────────────
  let rxCodigo = null;
  const conRecetas = accesses.slice(0, Math.min(accesses.length, Math.floor(cfg.patients * 0.5)));
  for (const a of conRecetas) {
    for (let i = 0; i < int(1, 3); i++) {
      const ts = tsOf(isoDate(addDays(today, -int(0, 300))), `${pad(int(8, 19))}:${pad(int(0, 59))}`);
      const prescriptionId = id('RX', int(1, 999999));
      const codigo = hash(`${prescriptionId}${ts}`).slice(0, 20).toUpperCase();
      rxCodigo ??= codigo;
      const estado = chance(0.07) ? 'CANCELLED' : 'EMITTED';
      w.put({
        ...K.rx(a.patientId, ts, prescriptionId),
        tipo: 'Receta',
        patientId: a.patientId,
        organizationId: a.organizationId,
        doctorUserId: a.doctorUserId,
        prescriptionId,
        estado,
        tsISO: ts,
        codigo,
        // D-16: informativa, sin validez oficial.
        leyenda: 'Documento informativo. Sin validez oficial ni integración institucional.',
        medicamentos: [
          { nombre: 'Paracetamol 500 mg', dosis: '1 tableta cada 8 h', dias: 5 },
          { nombre: 'Omeprazol 20 mg', dosis: '1 cápsula en ayunas', dias: 14 },
        ],
        s3Key: `org/${a.organizationId}/rx/${prescriptionId}.pdf`,
        ...G.gsi2Rx(a.patientId, a.organizationId, ts, prescriptionId),
        ...G.gsi4DoctorRx(a.doctorUserId, a.organizationId, ts, prescriptionId),
      });
      // El guardián guarda patientId y tsISO: sin ellos AP-91 no puede reconstruir
      // la clave de la receta y verificarla exigiría un Scan.
      w.put({
        ...K.uniqRxCode(codigo),
        tipo: 'GuardianCodigoReceta',
        patientId: a.patientId,
        prescriptionId,
        tsISO: ts,
        organizationId: a.organizationId,
      });
      w.put({
        ...K.rxEvent(a.patientId, prescriptionId, ts),
        tipo: 'EventoReceta',
        patientId: a.patientId,
        prescriptionId,
        accion: 'EMITIDA',
        actor: a.doctorUserId,
      });
      if (estado === 'CANCELLED') {
        w.put({
          ...K.rxEvent(a.patientId, prescriptionId, tsOf(isoDate(addDays(today, -int(0, 30))), '16:00')),
          tipo: 'EventoReceta',
          patientId: a.patientId,
          prescriptionId,
          accion: 'CANCELADA',
          actor: a.doctorUserId,
          motivo: 'Error en la dosis indicada',
        });
      }
    }
  }

  // ───────────────── alertas de pánico ─────────────────
  for (let i = 0; i < 40; i++) {
    const p = pick(patients);
    const oid = p.orgPrimary;
    const ts = tsOf(isoDate(addDays(today, -int(0, 60))), `${pad(int(0, 23))}:${pad(int(0, 59))}`);
    const alertId = id('PN', int(1, 999999));
    const estado = i < 12 ? pick(['OPEN', 'ACKNOWLEDGED']) : 'CLOSED';
    const item = {
      ...K.panic(p.patientId, ts, alertId),
      tipo: 'AlertaPanico',
      patientId: p.patientId,
      organizationId: oid,
      alertId,
      estado,
      tsISO: ts,
      contexto: { origen: 'APP_MOVIL', ubicacionAprox: chance(0.5) ? 'compartida' : null },
      // El sistema no afirma que la ayuda fue prestada por haber enviado un aviso.
      notas: estado === 'CLOSED' ? 'Se contactó al paciente y se canalizó a urgencias' : null,
    };
    if (estado !== 'CLOSED') Object.assign(item, G.gsi3Panic(oid, ts, alertId));
    w.put(item);
    w.put({ ...K.uniqPanic(p.patientId, ts.slice(0, 13)), tipo: 'GuardianPanico', patientId: p.patientId, alertId });
  }

  // ───────────────── notificaciones ─────────────────
  onProgress('Generando notificaciones y pagos…');
  let notifKey = null;
  let notifAppointmentId = null;
  for (const a of appts.slice(0, Math.min(appts.length, 2500))) {
    for (const canal of chance(0.5) ? ['EMAIL', 'WHATSAPP'] : ['EMAIL']) {
      const ts = tsOf(a.fecha, '07:00');
      const idem = hash(`RECORDATORIO:${a.appointmentId}:${canal}`).slice(0, 24);
      notifKey ??= idem;
      notifAppointmentId ??= a.appointmentId;
      w.put({
        ...K.notification(idem),
        tipo: 'Notificacion',
        idempotencyKey: idem,
        organizationId: a.organizationId,
        appointmentId: a.appointmentId,
        patientId: a.patientId,
        canal,
        evento: 'RECORDATORIO',
        // Se normaliza sin inventar confirmaciones que el proveedor no da (HU-045).
        estado: pick(['SENT', 'DELIVERED', 'READ', 'FAILED']),
        intentos: int(1, 3),
        providerMessageId: `msg_${hash(idem).slice(0, 16)}`,
        errorSanitizado: null,
        tsISO: ts,
        ...G.gsi2OrgNotif(a.organizationId, ts, idem),
        ...G.gsi4ApptNotif(a.appointmentId, ts, canal),
      });
    }
  }

  // ───────────────── pagos y webhooks ─────────────────
  let sample = { paymentId: null, payerUserId: null, providerPaymentId: null, providerEventId: null };
  const provider = 'stripe';
  for (const s of paymentsSeed.slice(0, Math.min(paymentsSeed.length, 3000))) {
    const paymentId = id('PY', int(1, 999999));
    const providerPaymentId = `pi_${hash(paymentId).slice(0, 20)}`;
    const payer = pick(linkedUsers.length ? linkedUsers : [{ userId: allUsers[0].userId }]).userId;
    const ts = tsOf(s.fecha, '09:30');
    const estado = s.estado === 'PENDING_PAYMENT' ? pick(['CREATED', 'PENDING']) : pick(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'FAILED', 'REFUNDED']);

    const item = {
      ...K.payment(paymentId),
      tipo: 'Pago',
      paymentId,
      organizationId: s.oid,
      appointmentId: s.appointmentId,
      patientId: s.p.patientId,
      payerUserId: payer,
      provider,
      providerPaymentId,
      estado,
      importe: s.svc.importe,
      moneda: 'MXN',
      tsISO: ts,
      ...G.gsi2OrgPay(s.oid, ts, paymentId),
      ...G.gsi4Payer(payer, ts, paymentId),
    };
    // Sólo lo no liquidado ocupa la bandeja de conciliación (GSI3 disperso).
    if (['CREATED', 'PENDING'].includes(estado)) Object.assign(item, G.gsi3PayPending(s.oid, ts, paymentId));
    w.put(item);

    w.put({ ...K.uniqProviderPay(provider, providerPaymentId), tipo: 'GuardianProveedor', paymentId });
    w.put({ ...K.uniqIdempPay(hash(`ORDER:${s.appointmentId}`).slice(0, 24)), tipo: 'GuardianIdempotencia', paymentId });
    w.put({
      ...K.apptPayment(s.appointmentId, paymentId),
      tipo: 'PunteroPagoCita',
      appointmentId: s.appointmentId,
      paymentId,
      organizationId: s.oid,
      estado,
      importe: s.svc.importe,
      moneda: 'MXN',
    });
    w.put({
      ...K.payEvent(paymentId, ts, id('PE', int(1, 999999))),
      tipo: 'EventoPago',
      paymentId,
      organizationId: s.oid,
      accion: 'CREADO',
      estado,
      tsISO: ts,
    });
    if (estado === 'REFUNDED') {
      w.put({
        ...K.refund(paymentId, tsOf(s.fecha, '18:00'), id('RF', int(1, 999999))),
        tipo: 'Reembolso',
        paymentId,
        organizationId: s.oid,
        importe: s.svc.importe,
        moneda: 'MXN',
        motivo: 'Cancelación con más de 24 h de anticipación',
        estado: 'CONFIRMADO',
      });
    }

    // Eventos de webhook: la deduplicación es un PutItem condicional (D-18).
    const providerEventId = `evt_${hash(providerPaymentId).slice(0, 20)}`;
    const pendiente = chance(0.08);
    const wh = {
      ...K.webhookEvent(provider, providerEventId),
      tipo: 'EventoWebhook',
      provider,
      providerEventId,
      paymentId,
      estado: pendiente ? 'PENDIENTE' : 'PROCESADO',
      tipoEvento: 'checkout.session.completed',
      tsISO: ts,
      expiraEn: Math.floor(addDays(today, 30).getTime() / 1000),
    };
    if (pendiente) Object.assign(wh, G.gsi3WebhookPending(provider, ts, providerEventId));
    w.put(wh);

    if (!sample.paymentId) sample = { paymentId, payerUserId: payer, providerPaymentId, providerEventId };
  }

  // ───────────────── auditoría e indicadores ─────────────────
  onProgress('Generando auditoría e indicadores…');
  const actores = [...allUsers.slice(0, 60).map((u) => u.userId), 'SISTEMA'];
  const auditN = Math.min(20000, cfg.appointments * 2);
  for (let i = 0; i < auditN; i++) {
    // Un actor automático firma ~1/4 de la auditoría: partición de crecimiento ilimitado.
    const actor = chance(0.25) ? 'SISTEMA' : pick(actores);
    const date = isoDate(addDays(today, -int(0, 90)));
    const ts = tsOf(date, `${pad(int(0, 23))}:${pad(int(0, 59))}`, int(0, 59));
    const eventId = id('EV', i + 1);
    const oid = orgFor().id;
    w.put({
      ...K.audit(oid, actor, ts, eventId),
      tipo: 'Auditoria',
      actor,
      organizationId: oid,
      accion: pick(['LOGIN', 'EXPEDIENTE_LEIDO', 'NOTA_CREADA', 'CITA_AGENDADA', 'ACCESO_OTORGADO', 'PAGO_CONFIRMADO', 'ACCESO_DENEGADO']),
      recurso: pick(['PATIENT', 'APPT', 'NOTE', 'PAY']),
      resultado: chance(0.06) ? 'DENEGADO' : 'PERMITIDO',
      correlationId: hash(eventId).slice(0, 16),
      tsISO: ts,
      fecha: date,
      ...G.gsi4AuditOrgDay(oid, date, ts, eventId),
    });
  }

  for (const o of orgs) {
    // Agregado mensual: es lo que lee el dashboard para periodos largos.
    for (const mes of ['2026-07', '2026-08', '2026-09']) {
      for (const metrica of METRICAS) {
        w.put({
          ...K.statRollup(o.id, '2026', mes, metrica),
          tipo: 'IndicadorMensual',
          organizationId: o.id,
          mes,
          metrica,
          valor: int(0, o.id === 'ORG001' ? 5000 : 1200),
        });
      }
    }
    for (let d = 0; d < 90; d++) {
      const date = isoDate(addDays(today, -d));
      for (const metrica of METRICAS) {
        w.put({
          ...K.stat(o.id, date, metrica),
          tipo: 'Indicador',
          organizationId: o.id,
          fecha: date,
          metrica,
          valor: int(0, o.id === 'ORG001' ? 180 : 40),
        });
      }
      // HU-049 pide explícitamente "ocupación por médico" y no había métrica.
      for (const d of activeDoctors.filter((x) => (x.orgs ?? []).some((m) => m.organizationId === o.id)).slice(0, 8)) {
        w.put({
          ...K.statDoctor(o.id, date, d.userId),
          tipo: 'Indicador',
          organizationId: o.id,
          doctorUserId: d.userId,
          fecha: date,
          metrica: 'OCUPACION',
          minutosOcupados: int(0, 480),
          minutosDisponibles: 600,
        });
      }
    }
  }

  // ───────────────── escritura ─────────────────
  const itemCount = w.count;
  onProgress(`Escribiendo ${itemCount} items…`);
  await w.drain(onProgress);

  // ───────────────── fixtures ─────────────────
  const busyDayAppts = appts.filter((a) => a.doctorUserId === busyDoctor.userId && a.fecha === busyDay);
  const linked = linkedUsers[0];
  const sampleAccess = accesses[0] ?? { patientId: patients[0].patientId, organizationId: orgs[0].id, doctorUserId: doctors[0].userId };
  const samplePending = pendingAccesses[0] ?? sampleAccess;
  const nota = notesIdx[0];
  const conCitasFuturas = appts.find((a) => a.grupo === 'UPCOMING');
  const conCitasPasadas = appts.find((a) => a.grupo === 'PAST');
  const remotaAppt = appts.find((a) => a.modalidad === 'REMOTE');
  const conRx = conRecetas[0] ?? sampleAccess;
  const conVit = conVitales[0] ?? patients[0];
  const richPatient = patients.find((p) => p.orgs.includes(orgs[0].id)) ?? patients[0];
  const soloDoctor = doctors.find((d) => d.soloPracticeOrgId);

  const fixtures = {
    scale,
    items: itemCount,
    colisiones: w.colisiones,
    segundos: +((Date.now() - t0) / 1000).toFixed(1),
    hoy,
    // identidad
    emailNorm: doctors[0].email,
    userId: doctors[0].userId,
    googleSub: allUsers.find((u) => u.googleSub)?.googleSub ?? null,
    sessionId: doctors[0].sessions[0],
    cedulaNorm: normDoc(doctors[0].cedula),
    // organizaciones
    organizationId: orgs[0].id,
    organizationIdAlterno: orgs[1].id,
    soloPracticeOrgId: soloDoctor?.soloPracticeOrgId ?? orgs[3].id,
    serviceId: servicesByOrg[orgs[0].id][0].serviceId,
    inviteTokenHash,
    inviteEmail,
    // médicos y agenda
    doctorUserId: busyDoctor.userId,
    doctorOrgId: busyOrg,
    doctorBusyDay: busyDay,
    doctorBusyDayCitas: busyDayAppts.length,
    doctorUserIdAlterno: activeDoctors[2].userId,
    referralDoctorUserId: referralDoctor.userId,
    // pacientes
    patientId: richPatient.patientId,
    patientOrgId: richPatient.orgPrimary,
    patientDocNorm: normDoc(richPatient.documento),
    patientTipoDoc: 'CURP',
    patientContactoValor: richPatient.e164,
    patientNombrePrefijo: richPatient.nombreNorm.slice(0, 4),
    patientMergedId: dupA.patientId,
    patientCanonicoId: dupB.patientId,
    // vínculos y tutores
    linkedUserId: linked?.userId ?? null,
    linkedPatientId: linked?.patientId ?? null,
    guardianUserId: bigGuardian.userId,
    guardianContacto: bigGuardian.e164,
    guardianRepresentados: bigGuardian.representados.length,
    guardianPatientId: bigGuardian.representados[0],
    waE164: bigGuardian.e164,
    onboardingUserId: allUsers.find((u) => u.onboardingPendiente)?.userId ?? allUsers[0].userId,
    rechazadoUserId: rechazados[0]?.userId ?? null,
    rechazadoOrgId: rechazados[0]?.organizationId ?? orgs[0].id,
    // expediente
    accessPatientId: sampleAccess.patientId,
    accessOrgId: sampleAccess.organizationId,
    accessDoctorUserId: sampleAccess.doctorUserId,
    pendingAccessOrgId: samplePending.organizationId,
    referralPatientId: referralPatientId ?? sampleAccess.patientId,
    referralOrgId: referralOrgId ?? sampleAccess.organizationId,
    notePatientId: nota?.patientId ?? sampleAccess.patientId,
    noteOrgId: nota?.organizationId ?? sampleAccess.organizationId,
    noteId: nota?.noteId ?? null,
    noteVersiones: nota?.versiones ?? 1,
    // AP-57 necesita una nota que realmente tenga adjunto, no una cualquiera
    attachPatientId: notaConAdjunto?.patientId ?? nota?.patientId ?? sampleAccess.patientId,
    attachNoteId: notaConAdjunto?.noteId ?? nota?.noteId ?? null,
    vitalPatientId: conVit.patientId,
    vitalOrgId: conVit.orgPrimary,
    // citas
    appointmentId: busyDayAppts[0]?.appointmentId ?? appts[0].appointmentId,
    appointmentIdRemota: remotaAppt?.appointmentId ?? appts[0].appointmentId,
    patientConCitas: conCitasFuturas?.patientId ?? richPatient.patientId,
    patientConCitasPasadas: conCitasPasadas?.patientId ?? richPatient.patientId,
    remDate,
    // recetas, pánico
    rxPatientId: conRx.patientId,
    rxDoctorUserId: conRx.doctorUserId,
    rxOrgId: conRx.organizationId,
    rxCodigo,
    panicOrgId: orgs[0].id,
    // notificaciones y pagos
    notifKey,
    notifAppointmentId,
    provider,
    paymentId: sample.paymentId,
    payerUserId: sample.payerUserId,
    providerPaymentId: sample.providerPaymentId,
    providerEventId: sample.providerEventId,
    paymentAppointmentId: paymentsSeed[0]?.appointmentId ?? appts[0].appointmentId,
    // auditoría
    auditActorId: 'SISTEMA',
    auditDate: isoDate(addDays(today, -1)),
    auditMes: hoy.slice(0, 7),
    statMes: hoy.slice(0, 7),
    // sandbox: las escrituras usan ids únicos por corrida y no tocan el dataset
    sandboxOrgId: orgs[0].id,
    sandboxPatientId: patients[patients.length - 3].patientId,
    sandboxDoctorUserId: doctors[doctors.length - 1].userId,
    sandboxUserId: allUsers[allUsers.length - 1].userId,
    sandboxAppointmentId: appts[appts.length - 1].appointmentId,
    sandboxPaymentId: sample.paymentId,
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
