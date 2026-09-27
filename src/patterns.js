/**
 * Los 126 patrones de acceso de `Patrones de acceso.md`, ejecutables.
 *
 * Cada patrón replica exactamente el índice, la clave y las condiciones que
 * declara el documento. Si un patrón resulta caro aquí, es el modelado el que
 * hay que cambiar — no el patrón.
 *
 * Los patrones de escritura operan sobre entidades sandbox con id único por
 * corrida, para que puedan repetirse sin corromper el dataset ni fallar por
 * condición. Cuando una escritura necesita un estado previo concreto (una
 * membresía PENDING, un pago sin liquidar), se prepara con `c.silent()`, que no
 * contamina la medición.
 */
import {
  TABLE,
  K,
  G,
  norm,
  vpad,
  slotsFor,
  grupoDeEstado,
  mesesEntre,
  mesDe,
  APPT_GROUP,
  TTL_ATTR,
} from './keys.js';

let nonce = 0;
const uniq = () => `${Date.now().toString(36)}${(nonce++).toString(36)}`;
const T = TABLE;
const ahora = () => new Date().toISOString();

/** Query helper: arma los params reduciendo el ruido en cada patrón. */
const q = ({ index, pk, pkName, sk, skName, ...rest }) => {
  const p = {
    TableName: T,
    ...(index ? { IndexName: index } : {}),
    KeyConditionExpression: sk ? `#pk = :pk AND ${sk}` : '#pk = :pk',
    // #sk sólo se declara si la condición lo usa: DynamoDB rechaza nombres
    // declarados y no referenciados.
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

const desc = { ScanIndexForward: false };

export const GRUPOS = [
  'Identidad, sesión y consentimiento',
  'Organizaciones, membresías y capacidades',
  'Pacientes y representación',
  'Expediente clínico y acceso',
  'Signos vitales',
  'Citas',
  'Telemedicina e interconsultas',
  'Recetas electrónicas',
  'Botón de pánico',
  'Notificaciones y WhatsApp',
  'Pagos electrónicos',
  'Auditoría e indicadores',
];
const [IDENT, ORGS, PACIENTES, EXPEDIENTE, VITALES, CITAS, TELE, RECETAS, PANICO, NOTIF, PAGOS, AUDIT] =
  GRUPOS;

export const PATTERNS = [
  // ═══════════════════ 5.1 Identidad, sesión y consentimiento ═══════════════════
  {
    id: 'AP-01',
    grupo: IDENT,
    nombre: 'Resolver usuario por correo (login)',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'UNIQ#EMAIL#<emailNorm> / USER',
    hu: ['HU-001'],
    run: (c) =>
      // Guardián de unicidad en la tabla base: GetItem fuertemente consistente,
      // no una Query a GSI. Es lo que hace que el login no dependa de un índice.
      c.measure('GetItem', { TableName: T, Key: K.uniqEmail(c.f.emailNorm), ConsistentRead: true }),
  },
  {
    id: 'AP-02',
    grupo: IDENT,
    nombre: 'Resolver usuario por identidad Google',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'UNIQ#IDP#GOOGLE#<sub> / USER',
    hu: ['HU-001', 'HU-001a'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.uniqIdp(c.f.googleSub) }),
    skip: (f) => (f.googleSub ? null : 'El dataset no generó identidades federadas'),
  },
  {
    id: 'AP-03',
    grupo: IDENT,
    nombre: 'Obtener perfil y estado global de la cuenta',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'USER#<userId> / PROFILE',
    hu: ['HU-001', 'HU-001b'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.user(c.f.userId) }),
  },
  {
    id: 'AP-04',
    grupo: IDENT,
    nombre: 'Registrar usuario con correo único',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'UNIQ#EMAIL con attribute_not_exists + PROFILE',
    hu: ['HU-004'],
    escritura: true,
    run: (c) => {
      const userId = `SBXU${uniq()}`;
      const email = `sbx.${uniq()}@mediops.test`;
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: { ...K.uniqEmail(email), tipo: 'GuardianCorreo', userId, email },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: T,
              Item: { ...K.user(userId), tipo: 'Usuario', userId, email, estado: 'ACTIVE' },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-05',
    grupo: IDENT,
    nombre: 'Vincular identidad Google a un usuario existente',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'UNIQ#IDP condicional + IDENTITY#GOOGLE#<sub>',
    hu: ['HU-001a'],
    escritura: true,
    run: (c) => {
      const sub = `sbx${uniq()}`;
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: { ...K.uniqIdp(sub), tipo: 'GuardianIdP', userId: c.f.sandboxUserId, sub },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.identity(c.f.sandboxUserId, sub),
                tipo: 'IdentidadFederada',
                userId: c.f.sandboxUserId,
                sub,
                emailVerificado: true,
              },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-06',
    grupo: IDENT,
    nombre: 'Abrir sesión',
    prioridad: 'Alta',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'USER#<userId> / SESSION#<sessionId> con TTL',
    hu: ['HU-001', 'HU-001b'],
    escritura: true,
    run: (c) =>
      c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.session(c.f.sandboxUserId, `SBX${uniq()}`),
          tipo: 'Sesion',
          userId: c.f.sandboxUserId,
          issuedAt: ahora(),
          expiraEn: Math.floor(Date.now() / 1000) + 86400,
        },
      }),
  },
  {
    id: 'AP-07',
    grupo: IDENT,
    nombre: 'Validar sesión en cada renovación',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'SESSION#<sessionId>; se descarta si issuedAt < sessionsRevokedAt',
    hu: ['HU-001b'],
    run: (c) => {
      c.nota(
        'El corte contra sessionsRevokedAt se resuelve con el perfil que ya trae AP-03: ' +
          'la renovación no añade una segunda lectura.',
      );
      return c.measure('GetItem', {
        TableName: T,
        Key: K.session(c.f.userId, c.f.sessionId),
        ConsistentRead: true,
      });
    },
  },
  {
    id: 'AP-08',
    grupo: IDENT,
    nombre: 'Cerrar sesión en este dispositivo',
    prioridad: 'Media',
    op: 'DeleteItem',
    indice: 'Tabla',
    clave: 'USER#<userId> / SESSION#<sessionId>; idempotente',
    hu: ['HU-002'],
    escritura: true,
    run: (c) =>
      c.measure('DeleteItem', { TableName: T, Key: K.session(c.f.sandboxUserId, `SBX${uniq()}`) }),
  },
  {
    id: 'AP-09',
    grupo: IDENT,
    nombre: 'Cerrar sesión en todos los dispositivos',
    prioridad: 'Media',
    op: 'UpdateItem + Query',
    indice: 'Tabla',
    clave: 'fija sessionsRevokedAt y purga begins_with(SK,\'SESSION#\')',
    hu: ['HU-002', 'HU-002b', 'HU-002c'],
    escritura: true,
    fanout: true,
    run: async (c) => {
      await c.measure('UpdateItem', {
        TableName: T,
        Key: K.user(c.f.sandboxUserId),
        UpdateExpression: 'SET sessionsRevokedAt = :t',
        ExpressionAttributeValues: { ':t': ahora() },
      });
      // La marca en el perfil ya corta el acceso; la purga es limpieza, no seguridad.
      await c.measure(
        'Query',
        tablaQ(`USER#${c.f.sandboxUserId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'SESSION#' },
          extra: { ProjectionExpression: 'PK, SK' },
        }),
      );
    },
  },
  {
    id: 'AP-10',
    grupo: IDENT,
    nombre: 'Registrar aceptación del aviso de privacidad',
    prioridad: 'Media',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'CONSENT#<tipo>#<version>#<tsISO>, append-only',
    hu: ['HU-004b'],
    escritura: true,
    run: (c) =>
      c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.consent(c.f.sandboxUserId, 'AVISO_PRIVACIDAD', 'v3', ahora()),
          tipo: 'Consentimiento',
          userId: c.f.sandboxUserId,
          mecanismo: 'CHECKBOX',
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      }),
  },
  {
    id: 'AP-11',
    grupo: IDENT,
    nombre: 'Consultar historial de consentimientos',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: "USER#<userId>, begins_with(SK,'CONSENT#')",
    hu: ['HU-004b'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`USER#${c.f.userId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'CONSENT#' },
        }),
      ),
  },
  {
    id: 'AP-12',
    grupo: IDENT,
    nombre: 'Evaluar la política de MFA aplicable',
    prioridad: 'Alta',
    op: 'GetItem ×2',
    indice: 'Tabla',
    clave: 'USER#<userId>/PROFILE + ORG#<organizationId>/PROFILE, cacheable',
    hu: ['HU-002d'],
    fanout: true,
    run: async (c) => {
      c.nota('Ambos ítems son cacheables por petición: en producción esto es 0 lecturas en caliente.');
      await c.measure('GetItem', { TableName: T, Key: K.user(c.f.userId) });
      await c.measure('GetItem', { TableName: T, Key: K.org(c.f.organizationId) });
    },
  },
  {
    id: 'AP-13',
    grupo: IDENT,
    nombre: 'Obtener perfil médico',
    prioridad: 'Media',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'USER#<userId> / DOCTOR_PROFILE',
    hu: ['HU-003', 'HU-007a'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.doctorProfile(c.f.userId) }),
  },

  // ═══════════════ 5.2 Organizaciones, membresías y capacidades ═══════════════
  {
    id: 'AP-14',
    grupo: ORGS,
    nombre: 'Obtener organización y su zona horaria',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'ORG#<organizationId> / PROFILE, cacheable',
    hu: ['HU-006b', 'HU-029'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.org(c.f.organizationId) }),
  },
  {
    id: 'AP-15',
    grupo: ORGS,
    nombre: 'Alta de médico independiente',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'ORG + GOVERNANCE + DOCTOR_PROFILE + UNIQ#LICENSE + MEMBERSHIP OWNER+DOCTOR',
    hu: ['HU-003'],
    escritura: true,
    run: (c) => {
      const oid = `SBXORG${uniq()}`;
      const userId = `SBXD${uniq()}`;
      const cedula = `SBXCED${uniq()}`.toUpperCase();
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { ...K.org(oid), tipo: 'Organizacion', organizationId: oid, type: 'SOLO_PRACTICE', estado: 'ACTIVE' }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: T, Item: { ...K.governance(oid), tipo: 'Gobierno', organizationId: oid, activeOwners: 1 } } },
          { Put: { TableName: T, Item: { ...K.doctorProfile(userId), tipo: 'PerfilMedico', userId, cedula } } },
          { Put: { TableName: T, Item: { ...K.uniqLicense(cedula), tipo: 'GuardianCedula', userId }, ConditionExpression: 'attribute_not_exists(PK)' } },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.membership(userId, oid),
                tipo: 'Membresia',
                userId,
                organizationId: oid,
                governanceRole: 'OWNER',
                operationalRole: 'DOCTOR',
                estado: 'ACTIVE',
                ...G.gsi4OrgMember(oid, 'DOCTOR', 'ACTIVE', userId),
              },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-139',
    grupo: ORGS,
    nombre: 'Alta de clínica o centro médico',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave:
      'UNIQ#IDEMP#ORGCREATE#<userId>#<clave> + ORG (CLINIC/MEDICAL_CENTER) + GOVERNANCE + CAPPOLICY + MEMBERSHIP OWNER',
    hu: ['HU-003b'],
    escritura: true,
    claveDeterminista: true,
    sinReescritura:
      'La clave la genera el cliente por cada intento de alta: un reintento con la misma clave ' +
      'debe devolver la organización ya creada, nunca crear otra. Un alta nueva usa otra clave, ' +
      'y el TTL de 24 h libera el guardián.',
    run: (c) => {
      const oid = `SBXORG${uniq()}`;
      const userId = `SBXA${uniq()}`;
      const clave = uniq();
      c.nota(
        'Administrar no concede acceso clínico (D-03): quien sólo administra entra como OWNER + NONE. ' +
          'Si además atiende sin perfil médico, la transacción suma DOCTOR_PROFILE y UNIQ#LICENSE como en AP-15.',
      );
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: {
                ...K.uniqIdempOrgCreate(userId, clave),
                tipo: 'GuardianIdempotencia',
                organizationId: oid,
                [TTL_ATTR]: Math.floor(Date.now() / 1000) + 86400,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          { Put: { TableName: T, Item: { ...K.org(oid), tipo: 'Organizacion', organizationId: oid, type: 'CLINIC', estado: 'ACTIVE' }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: T, Item: { ...K.governance(oid), tipo: 'Gobierno', organizationId: oid, activeOwners: 1 }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: T, Item: { ...K.capPolicy(oid), tipo: 'PoliticaCapacidades', organizationId: oid } } },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.membership(userId, oid),
                tipo: 'Membresia',
                userId,
                organizationId: oid,
                governanceRole: 'OWNER',
                operationalRole: 'NONE',
                estado: 'ACTIVE',
                ...G.gsi4OrgMember(oid, 'NONE', 'ACTIVE', userId),
              },
              ConditionExpression: 'attribute_not_exists(SK)',
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-16',
    grupo: ORGS,
    nombre: 'Listar mis membresías',
    prioridad: 'Muy alta',
    op: 'Query',
    indice: 'Tabla',
    clave: "USER#<userId>, begins_with(SK,'MEMBERSHIP#ORG#')",
    hu: ['HU-006b', 'HU-007a'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`USER#${c.f.userId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'MEMBERSHIP#ORG#' },
        }),
      ),
  },
  {
    id: 'AP-17',
    grupo: ORGS,
    nombre: 'Verificar la membresía del contexto activo',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'USER#<userId> / MEMBERSHIP#ORG#<organizationId>',
    hu: ['HU-006b', 'D-07'],
    run: (c) => {
      c.nota('Corre en cada petición organizacional: enviar un organizationId desde el cliente nunca basta.');
      return c.measure('GetItem', {
        TableName: T,
        Key: K.membership(c.f.userId, c.f.doctorOrgId),
        ConsistentRead: true,
      });
    },
  },
  {
    id: 'AP-18',
    grupo: ORGS,
    nombre: 'Resolver capacidades efectivas',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'ORG#<organizationId> / CAPPOLICY combinado con la membresía de AP-17',
    hu: ['HU-007a', 'D-13'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.capPolicy(c.f.organizationId) }),
  },
  {
    id: 'AP-19',
    grupo: ORGS,
    nombre: 'Listar miembros por rol operativo y estado',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI4',
    clave: "GSI4PK = ORG#<organizationId>#MEMBER, begins_with(GSI4SK,'DOCTOR#ACTIVE#')",
    hu: ['HU-007'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(4, `ORG#${c.f.organizationId}#MEMBER`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'DOCTOR#ACTIVE#' },
        }),
        { index: 'GSI4' },
      ),
  },
  {
    id: 'AP-20',
    claveDeterminista: true,
    grupo: ORGS,
    nombre: 'Solicitar ingreso a una organización',
    prioridad: 'Baja',
    op: 'PutItem condicional',
    indice: 'Tabla',
    clave: 'MEMBERSHIP en PENDING con GSI3PK = MEMBERREQ#<organizationId>',
    hu: ['HU-003'],
    escritura: true,
    run: (c) => {
      const userId = `SBXU${uniq()}`;
      const ts = ahora();
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.membership(userId, c.f.sandboxOrgId),
          tipo: 'Membresia',
          userId,
          organizationId: c.f.sandboxOrgId,
          governanceRole: 'MEMBER',
          operationalRole: 'DOCTOR',
          estado: 'PENDING',
          ...G.gsi4OrgMember(c.f.sandboxOrgId, 'DOCTOR', 'PENDING', userId),
          ...G.gsi3MemberRequest(c.f.sandboxOrgId, ts, userId),
        },
        // Consolida solicitudes repetidas SIN cerrar la puerta para siempre:
        // con `attribute_not_exists` a secas, un candidato rechazado no podía
        // volver a solicitar ingreso nunca más, y HU-003a exige conservar el
        // historial del rechazo — así que el ítem sigue ahí.
        ConditionExpression: 'attribute_not_exists(SK) OR estado IN (:rej, :end)',
        ExpressionAttributeValues: { ':rej': 'REJECTED', ':end': 'ENDED' },
      });
    },
  },
  {
    id: 'AP-21',
    grupo: ORGS,
    nombre: 'Bandeja de solicitudes de membresía',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI3',
    clave: 'GSI3PK = MEMBERREQ#<organizationId> (disperso)',
    hu: ['HU-003a'],
    run: (c) =>
      c.measure('Query', gsiQ(3, `MEMBERREQ#${c.f.organizationId}`), { index: 'GSI3' }),
  },
  {
    id: 'AP-22',
    grupo: ORGS,
    nombre: 'Aprobar o rechazar una solicitud',
    prioridad: 'Media',
    op: 'UpdateItem condicional',
    indice: 'Tabla',
    clave: 'condición estado = PENDING y elimina GSI3PK',
    hu: ['HU-003a'],
    escritura: true,
    run: async (c) => {
      const userId = `SBXU${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: {
          ...K.membership(userId, c.f.sandboxOrgId),
          tipo: 'Membresia',
          userId,
          organizationId: c.f.sandboxOrgId,
          estado: 'PENDING',
          ...G.gsi3MemberRequest(c.f.sandboxOrgId, ahora(), userId),
        },
      });
      c.nota('La condición estado = PENDING es lo que resuelve la carrera entre dos administradores.');
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.membership(userId, c.f.sandboxOrgId),
        UpdateExpression: 'SET estado = :nuevo REMOVE GSI3PK, GSI3SK',
        ConditionExpression: 'estado = :pend',
        ExpressionAttributeValues: { ':nuevo': 'ACTIVE', ':pend': 'PENDING' },
      });
    },
  },
  {
    id: 'AP-23',
    grupo: ORGS,
    nombre: 'Cambiar roles de una membresía',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'UpdateItem de la membresía + ADD sobre GOVERNANCE.activeOwners con condición',
    hu: ['HU-006'],
    escritura: true,
    run: async (c) => {
      const userId = `SBXU${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.membership(userId, c.f.sandboxOrgId), tipo: 'Membresia', userId, estado: 'ACTIVE', governanceRole: 'MEMBER' },
      });
      c.nota('El contador activeOwners con condición es lo que impide dejar la organización sin OWNER.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.membership(userId, c.f.sandboxOrgId),
              UpdateExpression: 'SET governanceRole = :g',
              ExpressionAttributeValues: { ':g': 'OWNER' },
            },
          },
          {
            Update: {
              TableName: T,
              Key: K.governance(c.f.sandboxOrgId),
              UpdateExpression: 'ADD activeOwners :uno',
              ConditionExpression: 'activeOwners > :cero',
              ExpressionAttributeValues: { ':uno': 1, ':cero': 0 },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-24',
    grupo: ORGS,
    nombre: 'Suspender o reactivar una membresía',
    prioridad: 'Baja',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'sólo afecta a ese tenant; el GSI4SK se reescribe con el nuevo estado',
    hu: ['HU-006a'],
    escritura: true,
    run: (c) => {
      const userId = `SBXU${uniq()}`;
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.membership(userId, c.f.sandboxOrgId),
        UpdateExpression: 'SET estado = :e, GSI4SK = :sk',
        ExpressionAttributeValues: {
          ':e': 'SUSPENDED',
          ':sk': G.gsi4OrgMember(c.f.sandboxOrgId, 'DOCTOR', 'SUSPENDED', userId).GSI4SK,
        },
      });
    },
  },
  {
    id: 'AP-26',
    grupo: ORGS,
    nombre: 'Crear invitación de personal',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'INVITE#<inviteId> + UNIQ#INVITE#<tokenHash>, ambos con TTL',
    hu: ['HU-005'],
    escritura: true,
    run: (c) => {
      const inviteId = `SBXINV${uniq()}`;
      const tokenHash = `sbx${uniq()}`;
      const ttl = Math.floor(Date.now() / 1000) + 604800;
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { ...K.invite(c.f.sandboxOrgId, inviteId), tipo: 'Invitacion', organizationId: c.f.sandboxOrgId, inviteId, estado: 'PENDING', expiraEn: ttl } } },
          { Put: { TableName: T, Item: { ...K.uniqInviteToken(tokenHash), tipo: 'GuardianInvitacion', organizationId: c.f.sandboxOrgId, inviteId, expiraEn: ttl }, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      });
    },
  },
  {
    id: 'AP-27',
    grupo: ORGS,
    nombre: 'Resolver invitación por token',
    prioridad: 'Baja',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'UNIQ#INVITE#<tokenHash>',
    hu: ['HU-005'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.uniqInviteToken(c.f.inviteTokenHash) }),
    skip: (f) => (f.inviteTokenHash ? null : 'El dataset no generó invitaciones'),
  },
  {
    id: 'AP-28',
    claveDeterminista: true,
    grupo: ORGS,
    nombre: 'Aceptar invitación',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'consume la invitación con condición estado = PENDING y crea o activa la membresía',
    hu: ['HU-005'],
    escritura: true,
    run: async (c) => {
      const inviteId = `SBXINV${uniq()}`;
      const userId = `SBXU${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.invite(c.f.sandboxOrgId, inviteId), tipo: 'Invitacion', estado: 'PENDING' },
      });
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.invite(c.f.sandboxOrgId, inviteId),
              UpdateExpression: 'SET estado = :usada',
              ConditionExpression: 'estado = :pend',
              ExpressionAttributeValues: { ':usada': 'ACCEPTED', ':pend': 'PENDING' },
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.membership(userId, c.f.sandboxOrgId),
                tipo: 'Membresia',
                userId,
                organizationId: c.f.sandboxOrgId,
                estado: 'ACTIVE',
                ...G.gsi4OrgMember(c.f.sandboxOrgId, 'NURSE', 'ACTIVE', userId),
              },
              // Sin esta condición, aceptar una invitación a MEMBER+NURSE
              // sobrescribía en silencio una membresía OWNER+DOCTOR existente y
              // dejaba mintiendo al contador activeOwners: HU-006 se violaba por
              // la puerta de atrás. Con membresía viva, la invitación es no-op.
              ConditionExpression: 'attribute_not_exists(SK) OR estado IN (:rej, :end)',
              ExpressionAttributeValues: { ':rej': 'REJECTED', ':end': 'ENDED' },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-29',
    grupo: ORGS,
    nombre: 'Fijar organización activa',
    prioridad: 'Media',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'USER#<userId>/PROFILE.activeOrganizationId (preferencia, no autorización)',
    hu: ['HU-006b'],
    escritura: true,
    run: (c) =>
      c.measure('UpdateItem', {
        TableName: T,
        Key: K.user(c.f.sandboxUserId),
        UpdateExpression: 'SET activeOrganizationId = :o',
        ExpressionAttributeValues: { ':o': c.f.sandboxOrgId },
      }),
  },

  // ═══════════════════ 5.3 Pacientes y representación ═══════════════════
  {
    id: 'AP-30',
    grupo: PACIENTES,
    nombre: 'Obtener ficha del paciente',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'PATIENT#<patientId> / PROFILE',
    hu: ['HU-009a'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.patient(c.f.patientId) }),
  },
  {
    id: 'AP-31',
    grupo: PACIENTES,
    nombre: 'Buscar por documento dentro del tenant',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'UNIQ#PATDOC#<organizationId>#<tipoDoc>#<docNorm>',
    hu: ['HU-009'],
    run: (c) => {
      c.nota('El documento es único por organización: la búsqueda no revela asociaciones en otros tenants.');
      return c.measure('GetItem', {
        TableName: T,
        Key: K.uniqPatientDoc(c.f.patientOrgId, c.f.patientTipoDoc, c.f.patientDocNorm),
      });
    },
  },
  {
    id: 'AP-32',
    grupo: PACIENTES,
    nombre: 'Buscar por teléfono o correo',
    prioridad: 'Alta',
    op: 'Query + GetItem',
    indice: 'GSI1',
    clave: 'GSI1PK = CONTACT#<canal>#<valorNorm>; devuelve 1..N dueños',
    hu: ['HU-009'],
    fanout: true,
    run: async (c) => {
      // GSI1 es KEYS_ONLY: el índice resuelve identidad, el detalle se lee de la tabla.
      // Ese segundo salto es real y por eso está medido aquí y no escondido.
      const r = await c.measure(
        'Query',
        gsiQ(1, `CONTACT#WHATSAPP#${c.f.patientContactoValor}`),
        { index: 'GSI1' },
      );
      c.nota('GSI1 es KEYS_ONLY: resuelve al dueño y el detalle exige un segundo salto a la tabla.');
      for (const it of (r.Items ?? []).slice(0, 3)) {
        await c.measure('GetItem', { TableName: T, Key: { PK: it.PK, SK: 'PROFILE' } });
      }
    },
  },
  {
    id: 'AP-33',
    grupo: PACIENTES,
    nombre: 'Buscar por prefijo de nombre',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI4',
    clave: "GSI4PK = ORG#<organizationId>#PATIENT, begins_with(GSI4SK,'ACTIVE#NAME#<pref>')",
    hu: ['HU-010'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(4, `ORG#${c.f.patientOrgId}#PATIENT`, {
          sk: 'begins_with(#sk, :sk)',
          // El estado va delante del nombre: filtra por ACTIVE y busca por prefijo a la vez.
          values: { ':sk': `ACTIVE#NAME#${c.f.patientNombrePrefijo}` },
          extra: { Limit: 50 },
        }),
        { index: 'GSI4' },
      ),
  },
  {
    id: 'AP-34',
    grupo: PACIENTES,
    nombre: 'Listar pacientes de la organización',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI4',
    clave: 'GSI4PK = ORG#<organizationId>#PATIENT, paginado',
    hu: ['HU-010a'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(4, `ORG#${c.f.organizationId}#PATIENT`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'ACTIVE#' },
          extra: { Limit: 50 },
        }),
        { index: 'GSI4' },
      ),
  },
  {
    id: 'AP-35',
    grupo: PACIENTES,
    nombre: 'Verificar que el paciente pertenece al tenant',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'PATIENT#<patientId> / ENROLLMENT#ORG#<organizationId>',
    hu: ['HU-009a', 'HU-014'],
    run: (c) => {
      c.nota('Precede a toda operación clínica: sin enrollment activo no hay acceso al paciente.');
      return c.measure('GetItem', {
        TableName: T,
        Key: K.enrollment(c.f.patientId, c.f.patientOrgId),
        ConsistentRead: true,
      });
    },
  },
  {
    id: 'AP-36',
    grupo: PACIENTES,
    nombre: 'Registrar paciente y asociarlo',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'PROFILE + ENROLLMENT + UNIQ#PATDOC + UNIQ#IDEMP; todo o nada',
    hu: ['HU-008'],
    escritura: true,
    run: (c) => {
      const patientId = `SBXP${uniq()}`;
      const doc = `SBXDOC${uniq()}`.toUpperCase();
      const nombre = 'Sandbox Paciente Prueba';
      const oid = c.f.sandboxOrgId;
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { ...K.patient(patientId), tipo: 'Paciente', patientId, nombre, nombreNorm: norm(nombre), documento: doc, estado: 'ACTIVE' }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: T, Item: { ...K.enrollment(patientId, oid), tipo: 'Asociacion', patientId, organizationId: oid, estado: 'ACTIVE', nombreNorm: norm(nombre), ...G.gsi4OrgPatient(oid, 'ACTIVE', norm(nombre), patientId) } } },
          { Put: { TableName: T, Item: { ...K.uniqPatientDoc(oid, 'CURP', doc), tipo: 'GuardianDocumento', patientId }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: T, Item: { PK: `UNIQ#IDEMP#PATIENT#${uniq()}`, SK: 'PATIENT', tipo: 'GuardianIdempotencia', patientId }, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      });
    },
  },
  {
    id: 'AP-37',
    claveDeterminista: true,
    sinReescritura:
      'La reactivación reutiliza la misma relación mediante AP-42, no crea otra (HU-011b). ' +
      'Un enrollment INACTIVE debe reactivarse, no volver a insertarse.',
    grupo: PACIENTES,
    nombre: 'Asociar un paciente existente a otra organización',
    prioridad: 'Baja',
    op: 'PutItem condicional',
    indice: 'Tabla',
    clave: 'ENROLLMENT con attribute_not_exists(SK)',
    hu: ['HU-008a'],
    escritura: true,
    run: (c) => {
      const patientId = `SBXP${uniq()}`;
      c.nota('No copia expediente ni concede acceso clínico: sólo hace visible al paciente en el tenant.');
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.enrollment(patientId, c.f.sandboxOrgId),
          tipo: 'Asociacion',
          patientId,
          organizationId: c.f.sandboxOrgId,
          estado: 'ACTIVE',
          ...G.gsi4OrgPatient(c.f.sandboxOrgId, 'ACTIVE', 'sandbox', patientId),
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      });
    },
  },
  {
    id: 'AP-38',
    grupo: PACIENTES,
    nombre: 'Vincular cuenta con expediente',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'UNIQ#USERPATIENT#<userId> + PROFILE.linkedUserId, ambos condicionales',
    hu: ['HU-008b'],
    escritura: true,
    run: (c) => {
      const userId = `SBXU${uniq()}`;
      const patientId = `SBXP${uniq()}`;
      c.nota('El guardián impide que un User quede vinculado a dos identidades Patient.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { ...K.uniqUserPatient(userId), tipo: 'VinculoCuentaExpediente', userId, patientId }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: T, Item: { ...K.patient(patientId), tipo: 'Paciente', patientId, linkedUserId: userId } } },
        ],
      });
    },
  },
  {
    id: 'AP-39',
    grupo: PACIENTES,
    nombre: 'Resolver el Patient del usuario autenticado',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'UNIQ#USERPATIENT#<userId>',
    hu: ['HU-020', 'HU-030'],
    run: (c) => {
      c.nota('El patientId sale del vínculo verificado, nunca de un campo del cliente.');
      return c.measure('GetItem', { TableName: T, Key: K.uniqUserPatient(c.f.linkedUserId) });
    },
    skip: (f) => (f.linkedUserId ? null : 'El dataset no generó cuentas vinculadas a expediente'),
  },
  {
    id: 'AP-40',
    grupo: PACIENTES,
    nombre: 'Actualizar ficha administrativa',
    prioridad: 'Media',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'PATIENT#<patientId>/PROFILE con condición de versión',
    hu: ['HU-011', 'HU-011a'],
    escritura: true,
    run: (c) => {
      c.nota('Si cambia el nombre hay que reescribir el GSI4SK de cada enrollment: el coste crece con el nº de organizaciones.');
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.patient(`SBXP${uniq()}`),
        UpdateExpression: 'SET telefonoAlterno = :t, actualizadoEn = :a',
        ExpressionAttributeValues: { ':t': '+525500000000', ':a': ahora() },
      });
    },
  },
  {
    id: 'AP-41',
    grupo: PACIENTES,
    nombre: 'Registrar o verificar un contacto',
    prioridad: 'Media',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'CONTACT#<canal>#<valor> con proyección a GSI1 sólo tras verificar',
    hu: ['HU-011a'],
    escritura: true,
    run: (c) => {
      const patientId = `SBXP${uniq()}`;
      const valor = `+5215${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.contact(`PATIENT#${patientId}`, 'WHATSAPP', valor),
          tipo: 'Contacto',
          patientId,
          canal: 'WHATSAPP',
          valor,
          verificado: true,
          ...G.gsi1Contact('WHATSAPP', valor, `PATIENT#${patientId}`),
        },
      });
    },
  },
  {
    id: 'AP-42',
    grupo: PACIENTES,
    nombre: 'Activar o desactivar la asociación',
    prioridad: 'Baja',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'ENROLLMENT.estado con motivo; reescribe el prefijo de estado en GSI4SK',
    hu: ['HU-011b'],
    escritura: true,
    run: (c) => {
      const patientId = `SBXP${uniq()}`;
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.enrollment(patientId, c.f.sandboxOrgId),
        UpdateExpression: 'SET estado = :e, GSI4SK = :sk, motivo = :m',
        ExpressionAttributeValues: {
          ':e': 'INACTIVE',
          ':sk': G.gsi4OrgPatient(c.f.sandboxOrgId, 'INACTIVE', 'sandbox', patientId).GSI4SK,
          ':m': 'Baja administrativa',
        },
      });
    },
  },
  {
    id: 'AP-43',
    grupo: PACIENTES,
    nombre: 'Detectar candidatos a duplicado',
    prioridad: 'Baja',
    op: 'AP-31 + AP-32 + AP-33',
    indice: '—',
    clave: 'combinación de búsquedas exactas y por prefijo; nunca Scan y nunca automático',
    hu: ['HU-008c'],
    fanout: true,
    run: async (c) => {
      await c.measure('GetItem', {
        TableName: T,
        Key: K.uniqPatientDoc(c.f.patientOrgId, c.f.patientTipoDoc, c.f.patientDocNorm),
      });
      await c.measure('Query', gsiQ(1, `CONTACT#WHATSAPP#${c.f.patientContactoValor}`), { index: 'GSI1' });
      await c.measure(
        'Query',
        gsiQ(4, `ORG#${c.f.patientOrgId}#PATIENT`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `ACTIVE#NAME#${c.f.patientNombrePrefijo}` },
          extra: { Limit: 25 },
        }),
        { index: 'GSI4' },
      );
      c.nota('La consolidación nunca es automática: esto sólo produce candidatos para revisión humana.');
    },
  },
  {
    id: 'AP-44',
    grupo: PACIENTES,
    nombre: 'Consolidar pacientes duplicados',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'marca MERGEDINTO en el origen y reasocia enrollments, citas y relaciones',
    hu: ['HU-008c'],
    escritura: true,
    run: (c) => {
      const origen = `SBXP${uniq()}`;
      c.nota('Las notas y evidencias no se sobrescriben: el origen queda en estado MERGED y se conserva.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { ...K.mergedInto(origen), tipo: 'Consolidacion', patientId: origen, canonicoPatientId: c.f.patientId, motivo: 'Duplicado confirmado' } } },
          { Update: { TableName: T, Key: K.patient(origen), UpdateExpression: 'SET estado = :m', ExpressionAttributeValues: { ':m': 'MERGED' } } },
        ],
      });
    },
  },
  {
    id: 'AP-45',
    grupo: PACIENTES,
    nombre: 'Crear o actualizar una representación',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'GUARDIAN#USER#<guardianUserId> + GUARDIANEVT#',
    hu: ['HU-012', 'HU-012a'],
    escritura: true,
    run: (c) => {
      const patientId = `SBXP${uniq()}`;
      const guardianUserId = `SBXG${uniq()}`;
      const ts = ahora();
      c.nota('Crear la relación no concede acceso total: cada permiso se evalúa por separado.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: {
                ...K.guardian(patientId, guardianUserId),
                tipo: 'Representacion',
                patientId,
                userId: guardianUserId,
                estado: 'ACTIVE',
                viewAppointments: true,
                manageAppointments: false,
                ...G.gsi4Guardian(guardianUserId, 'ACTIVE', patientId),
              },
            },
          },
          { Put: { TableName: T, Item: { ...K.guardianEvent(patientId, guardianUserId, ts), tipo: 'EventoRepresentacion', accion: 'ALTA', actor: c.f.sandboxUserId } } },
        ],
      });
    },
  },
  {
    id: 'AP-46',
    grupo: PACIENTES,
    nombre: 'Listar representados de un tutor',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI4',
    clave: "GSI4PK = GUARDIAN#<guardianUserId>, begins_with(GSI4SK,'ACTIVE#')",
    hu: ['HU-013'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(4, `GUARDIAN#${c.f.guardianUserId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'ACTIVE#' },
        }),
        { index: 'GSI4' },
      ),
  },
  {
    id: 'AP-47',
    grupo: PACIENTES,
    nombre: 'Listar tutores de un paciente',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "PATIENT#<patientId>, begins_with(SK,'GUARDIAN#USER#')",
    hu: ['HU-009a', 'HU-041'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.guardianPatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'GUARDIAN#USER#' },
        }),
      ),
  },
  {
    id: 'AP-48',
    grupo: PACIENTES,
    nombre: 'Verificar un permiso concreto del tutor',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'PATIENT#<patientId> / GUARDIAN#USER#<guardianUserId>',
    hu: ['HU-012a', 'HU-032'],
    run: (c) => {
      c.nota('Se evalúa el permiso puntual (manageAppointments, viewHistory…), no un permiso genérico.');
      return c.measure('GetItem', {
        TableName: T,
        Key: K.guardian(c.f.guardianPatientId, c.f.guardianUserId),
        ConsistentRead: true,
      });
    },
  },
  {
    id: 'AP-49',
    grupo: PACIENTES,
    nombre: 'Historial de permisos de representación',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: "begins_with(SK,'GUARDIANEVT#<guardianUserId>#')",
    hu: ['HU-012a'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.guardianPatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `GUARDIANEVT#${c.f.guardianUserId}#` },
        }),
      ),
  },

  // ═══════════════════ 5.4 Expediente clínico y acceso ═══════════════════
  {
    id: 'AP-50',
    grupo: EXPEDIENTE,
    nombre: 'Verificar acceso médico-paciente',
    prioridad: 'Muy alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'PATIENT#<patientId> / ACCESS#ORG#<organizationId>#DOCTOR#<doctorUserId>',
    hu: ['HU-014'],
    run: (c) => {
      c.nota('Se comprueban estado ACTIVE y expiresAt en el servidor, sin confiar en el TTL.');
      return c.measure('GetItem', {
        TableName: T,
        Key: K.access(c.f.accessPatientId, c.f.accessOrgId, c.f.accessDoctorUserId),
        ConsistentRead: true,
      });
    },
  },
  {
    id: 'AP-51',
    clinico: true,
    grupo: EXPEDIENTE,
    nombre: 'Expediente cronológico',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = PATIENT#<patientId>#ORG#<organizationId>#NOTE, descendente y paginado',
    hu: ['HU-014'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(2, `PATIENT#${c.f.notePatientId}#ORG#${c.f.noteOrgId}#NOTE`, {
          extra: { ...desc, Limit: 25 },
        }),
        { index: 'GSI2' },
      ),
  },
  {
    id: 'AP-52',
    grupo: EXPEDIENTE,
    nombre: 'Obtener la versión vigente de una nota',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "begins_with(SK,'NOTE#<noteId>#V#'), descendente, Limit 1",
    hu: ['HU-016', 'HU-017'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.notePatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `NOTE#${c.f.noteId}#V#` },
          extra: { ...desc, Limit: 1 },
        }),
      ),
    skip: (f) => (f.noteId ? null : 'El dataset no generó notas clínicas'),
  },
  {
    id: 'AP-53',
    grupo: EXPEDIENTE,
    nombre: 'Listar versiones de una nota',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: "begins_with(SK,'NOTE#<noteId>#V#') ascendente",
    hu: ['HU-017'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.notePatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `NOTE#${c.f.noteId}#V#` },
        }),
      ),
    skip: (f) => (f.noteId ? null : 'El dataset no generó notas clínicas'),
  },
  {
    id: 'AP-54',
    grupo: EXPEDIENTE,
    nombre: 'Crear nota clínica',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'NOTE#<noteId>#V#00001 + UNIQ#IDEMP#NOTE#<key>',
    hu: ['HU-015'],
    escritura: true,
    run: (c) => {
      const noteId = `SBXN${uniq()}`;
      const key = uniq();
      c.nota('La clave idempotente es lo que evita que un reintento del cliente duplique la nota.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { PK: `UNIQ#IDEMP#NOTE#${key}`, SK: 'NOTE', tipo: 'GuardianIdempotencia', noteId }, ConditionExpression: 'attribute_not_exists(PK)' } },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.note(c.f.sandboxPatientId, noteId, 1),
                tipo: 'NotaClinica',
                patientId: c.f.sandboxPatientId,
                organizationId: c.f.sandboxOrgId,
                noteId,
                version: 1,
                contenido: 'Nota de laboratorio',
                fecha: ahora(),
                ...G.gsi2CurrentNote(c.f.sandboxPatientId, c.f.sandboxOrgId, ahora(), noteId),
              },
              ConditionExpression: 'attribute_not_exists(SK)',
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-55',
    grupo: EXPEDIENTE,
    nombre: 'Crear la versión n+1',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'Put de V<n+1> con attribute_not_exists(SK) y retirada de GSI2PK en V<n>',
    hu: ['HU-016'],
    escritura: true,
    run: async (c) => {
      const noteId = `SBXN${uniq()}`;
      const p = c.f.sandboxPatientId;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.note(p, noteId, 1), tipo: 'NotaClinica', noteId, version: 1, ...G.gsi2CurrentNote(p, c.f.sandboxOrgId, ahora(), noteId) },
      });
      c.nota('attribute_not_exists(SK) sobre V<n+1>: dos editores simultáneos no producen dos versiones n+1.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: {
                ...K.note(p, noteId, 2),
                tipo: 'NotaClinica',
                patientId: p,
                noteId,
                version: 2,
                motivoEdicion: 'Corrección de dosis',
                ...G.gsi2CurrentNote(p, c.f.sandboxOrgId, ahora(), noteId),
              },
              ConditionExpression: 'attribute_not_exists(SK)',
            },
          },
          // La versión anterior sale del índice, pero permanece inmutable en la tabla.
          { Update: { TableName: T, Key: K.note(p, noteId, 1), UpdateExpression: 'REMOVE GSI2PK, GSI2SK' } },
        ],
      });
    },
  },
  {
    id: 'AP-56',
    grupo: EXPEDIENTE,
    nombre: 'Registrar adjunto',
    prioridad: 'Media',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'ATTACH#<noteId>#<attachmentId> con s3Key, tipo y tamaño',
    hu: ['HU-015'],
    escritura: true,
    run: (c) => {
      const attachmentId = `SBXAT${uniq()}`;
      c.nota('El archivo va a S3 privado; la tabla guarda sólo la referencia (D-10).');
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.attachment(c.f.sandboxPatientId, `SBXN${uniq()}`, attachmentId),
          tipo: 'Adjunto',
          patientId: c.f.sandboxPatientId,
          s3Key: `org/${c.f.sandboxOrgId}/pat/${c.f.sandboxPatientId}/${attachmentId}.pdf`,
          contentType: 'application/pdf',
          bytes: 128000,
        },
      });
    },
  },
  {
    id: 'AP-57',
    grupo: EXPEDIENTE,
    nombre: 'Autorizar y listar adjuntos',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "begins_with(SK,'ATTACH#<noteId>#') antes de firmar una URL temporal",
    hu: ['HU-020a'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.attachPatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': `ATTACH#${c.f.attachNoteId}#` },
        }),
      ),
    skip: (f) => (f.attachNoteId ? null : 'El dataset no generó adjuntos'),
  },
  {
    id: 'AP-58',
    claveDeterminista: true,
    grupo: EXPEDIENTE,
    nombre: 'Solicitar acceso a expediente',
    prioridad: 'Media',
    op: 'PutItem condicional',
    indice: 'Tabla',
    clave: 'ACCESS# en PENDING; la condición admite reescribir un acceso REVOKED o EXPIRED',
    hu: ['HU-018'],
    escritura: true,
    run: (c) => {
      const patientId = `SBXP${uniq()}`;
      const ts = ahora();
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.access(patientId, c.f.sandboxOrgId, c.f.sandboxDoctorUserId),
          tipo: 'AccesoMedicoPaciente',
          patientId,
          organizationId: c.f.sandboxOrgId,
          doctorUserId: c.f.sandboxDoctorUserId,
          estado: 'PENDING',
          motivo: 'Valoración solicitada',
          tsISO: ts,
          ...G.gsi4DoctorPatients(c.f.sandboxDoctorUserId, c.f.sandboxOrgId, 'PENDING', patientId),
          ...G.gsi3AccessRequest(c.f.sandboxOrgId, ts, patientId, c.f.sandboxDoctorUserId),
        },
        // La clave es determinista por (paciente, organización, médico), así que
        // el ítem sobrevive a la revocación. Con `attribute_not_exists` a secas
        // el médico no podía volver a solicitar acceso jamás. HU-018 sólo pide
        // idempotencia sobre las solicitudes ACTIVAS.
        ConditionExpression: 'attribute_not_exists(SK) OR estado IN (:rev, :exp)',
        ExpressionAttributeValues: { ':rev': 'REVOKED', ':exp': 'EXPIRED' },
      });
    },
  },
  {
    id: 'AP-59',
    grupo: EXPEDIENTE,
    nombre: 'Bandeja de solicitudes de acceso',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI3',
    clave: 'GSI3PK = ACCESSREQ#<organizationId> (disperso)',
    hu: ['HU-019'],
    run: (c) =>
      c.measure('Query', gsiQ(3, `ACCESSREQ#${c.f.pendingAccessOrgId}`), { index: 'GSI3' }),
  },
  {
    id: 'AP-60',
    grupo: EXPEDIENTE,
    nombre: 'Otorgar acceso',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'condición estado = PENDING, fija scope y expiresAt, elimina GSI3PK y añade ACCESSEVT#',
    hu: ['HU-019'],
    escritura: true,
    run: async (c) => {
      const patientId = `SBXP${uniq()}`;
      const ts = ahora();
      await c.silent('PutItem', {
        TableName: T,
        Item: {
          ...K.access(patientId, c.f.sandboxOrgId, c.f.sandboxDoctorUserId),
          tipo: 'AccesoMedicoPaciente',
          estado: 'PENDING',
          ...G.gsi3AccessRequest(c.f.sandboxOrgId, ts, patientId, c.f.sandboxDoctorUserId),
        },
      });
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.access(patientId, c.f.sandboxOrgId, c.f.sandboxDoctorUserId),
              UpdateExpression: 'SET estado = :a, expiresAt = :e, #src = :s REMOVE GSI3PK, GSI3SK',
              ConditionExpression: 'estado = :p',
              ExpressionAttributeNames: { '#src': 'source' },
              ExpressionAttributeValues: { ':a': 'ACTIVE', ':p': 'PENDING', ':e': '2027-01-01', ':s': 'CONSENTIMIENTO_PACIENTE' },
            },
          },
          { Put: { TableName: T, Item: { ...K.accessEvent(patientId, ts, `SBXAE${uniq()}`), tipo: 'EventoAcceso', accion: 'OTORGADO', actor: c.f.sandboxUserId } } },
        ],
      });
    },
  },
  {
    id: 'AP-61',
    grupo: EXPEDIENTE,
    nombre: 'Revocar acceso',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'ACTIVE → REVOKED con motivo + ACCESSEVT#',
    hu: ['HU-019'],
    escritura: true,
    run: async (c) => {
      const patientId = `SBXP${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.access(patientId, c.f.sandboxOrgId, c.f.sandboxDoctorUserId), tipo: 'AccesoMedicoPaciente', estado: 'ACTIVE' },
      });
      c.nota('La revocación surte efecto en la siguiente verificación (AP-50), no de forma diferida.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.access(patientId, c.f.sandboxOrgId, c.f.sandboxDoctorUserId),
              UpdateExpression: 'SET estado = :r, motivo = :m REMOVE GSI4PK, GSI4SK',
              ConditionExpression: 'estado = :a',
              ExpressionAttributeValues: { ':r': 'REVOKED', ':a': 'ACTIVE', ':m': 'Fin del episodio' },
            },
          },
          { Put: { TableName: T, Item: { ...K.accessEvent(patientId, ahora(), `SBXAE${uniq()}`), tipo: 'EventoAcceso', accion: 'REVOCADO' } } },
        ],
      });
    },
  },
  {
    id: 'AP-62',
    grupo: EXPEDIENTE,
    nombre: 'Listar pacientes de un médico',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'GSI4',
    clave: "GSI4PK = DOCTOR#<doctorUserId>#ORG#<organizationId>, begins_with(GSI4SK,'ACTIVE#')",
    hu: ['HU-014'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(4, `DOCTOR#${c.f.accessDoctorUserId}#ORG#${c.f.accessOrgId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'ACTIVE#' },
        }),
        { index: 'GSI4' },
      ),
  },
  {
    id: 'AP-63',
    grupo: EXPEDIENTE,
    nombre: 'Historial de decisiones de acceso',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: "begins_with(SK,'ACCESSEVT#') por rango de fechas",
    hu: ['HU-019', 'HU-051'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.accessPatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'ACCESSEVT#' },
        }),
      ),
  },
  {
    id: 'AP-64',
    grupo: EXPEDIENTE,
    nombre: 'Consultar mi propio historial',
    prioridad: 'Media',
    op: 'AP-39 → AP-51, AP-66, AP-77',
    indice: '—',
    clave: 'el patientId sale del vínculo verificado, nunca del cuerpo de la petición',
    hu: ['HU-020'],
    fanout: true,
    run: async (c) => {
      const r = await c.measure('GetItem', { TableName: T, Key: K.uniqUserPatient(c.f.linkedUserId) });
      const pid = r.Item?.patientId ?? c.f.linkedPatientId;
      await c.measure(
        'Query',
        gsiQ(2, `PATIENT#${pid}#ORG#${c.f.patientOrgId}#NOTE`, { extra: { ...desc, Limit: 10 } }),
        { index: 'GSI2' },
      );
      await c.measure(
        'Query',
        tablaQ(`PATIENT#${pid}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'RX#' },
          extra: { ...desc, Limit: 10 },
        }),
      );
      c.nota('El usuario no puede cambiar el patientId: sale del guardián UNIQ#USERPATIENT.');
    },
    skip: (f) => (f.linkedUserId ? null : 'El dataset no generó cuentas vinculadas a expediente'),
  },

  // ═══════════════════ 5.5 Signos vitales ═══════════════════
  {
    id: 'AP-65',
    grupo: VITALES,
    nombre: 'Registrar una toma de signos vitales',
    prioridad: 'Media',
    op: 'PutItem condicional',
    indice: 'Tabla',
    clave: 'VITAL#<tsISO>#<vitalId> con attribute_not_exists(SK) e origin NURSE/DOCTOR/PATIENT',
    hu: ['HU-021', 'HU-022'],
    escritura: true,
    run: (c) => {
      c.nota('El origen nunca se mezcla: un autorregistro del paciente no es una medición clínica validada.');
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.vital(c.f.sandboxPatientId, ahora(), `SBXV${uniq()}`),
          tipo: 'SignosVitales',
          patientId: c.f.sandboxPatientId,
          organizationId: c.f.sandboxOrgId,
          origin: 'NURSE',
          mediciones: { fc: { valor: 72, unidad: 'lpm' }, spo2: { valor: 98, unidad: '%' } },
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      });
    },
  },
  {
    id: 'AP-66',
    clinico: true,
    grupo: VITALES,
    nombre: 'Serie por rango de fechas',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = PATIENT#<p>#ORG#<o>#VITAL, GSI2SK between fechas',
    hu: ['HU-023'],
    run: (c) => {
      c.nota('Acotado por organización: sobre la tabla, esta consulta cruzaba tenants (HU-023).');
      return c.measure(
        'Query',
        gsiQ(2, `PATIENT#${c.f.vitalPatientId}#ORG#${c.f.vitalOrgId}#VITAL`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': '2026-01-01', ':b': '2026-12-31' },
        }),
        { index: 'GSI2' },
      );
    },
  },
  {
    id: 'AP-67',
    clinico: true,
    grupo: VITALES,
    nombre: 'Última toma registrada',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = PATIENT#<p>#ORG#<o>#VITAL, descendente, Limit 1',
    hu: ['HU-014', 'HU-023'],
    run: (c) => {
      c.nota('Acotado por organización, igual que AP-66: la consulta sobre la tabla cruzaba tenants.');
      return c.measure(
        'Query',
        gsiQ(2, `PATIENT#${c.f.vitalPatientId}#ORG#${c.f.vitalOrgId}#VITAL`, {
          extra: { ...desc, Limit: 1 },
        }),
        { index: 'GSI2' },
      );
    },
  },

  // ═══════════════════ 5.6 Citas ═══════════════════
  {
    id: 'AP-68',
    grupo: CITAS,
    nombre: 'Reglas de disponibilidad de un médico',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'Tabla',
    clave: "ORG#<organizationId>#DOCTOR#<doctorUserId>, begins_with(SK,'AVAIL#RULE#')",
    hu: ['HU-024', 'HU-025'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`ORG#${c.f.doctorOrgId}#DOCTOR#${c.f.doctorUserId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'AVAIL#RULE#' },
        }),
      ),
  },
  {
    id: 'AP-69',
    grupo: CITAS,
    nombre: 'Bloqueos y excepciones por rango',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'Tabla',
    clave: "SK between 'AVAIL#EXC#<desde>' and 'AVAIL#EXC#<hasta>'",
    hu: ['HU-024', 'HU-025'],
    run: (c) => {
      c.nota('Los bloqueos prevalecen sobre la regla recurrente: se leen antes de ofrecer un hueco.');
      return c.measure(
        'Query',
        tablaQ(`ORG#${c.f.doctorOrgId}#DOCTOR#${c.f.doctorUserId}`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': 'AVAIL#EXC#2026-01-01', ':b': 'AVAIL#EXC#2027-12-31' },
        }),
      );
    },
  },
  {
    id: 'AP-70',
    grupo: CITAS,
    nombre: 'Configurar disponibilidad',
    prioridad: 'Baja',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'no cancela citas existentes; el cambio se audita',
    hu: ['HU-024'],
    escritura: true,
    run: (c) =>
      c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.availException(c.f.sandboxOrgId, c.f.sandboxDoctorUserId, '2026-12-24', `SBXB${uniq()}`),
          tipo: 'BloqueoDisponibilidad',
          organizationId: c.f.sandboxOrgId,
          doctorUserId: c.f.sandboxDoctorUserId,
          desde: '13:00',
          hasta: '15:00',
          motivo: 'Bloqueo de laboratorio',
        },
      }),
  },
  {
    id: 'AP-71',
    grupo: CITAS,
    nombre: 'Servicios de la organización',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "ORG#<organizationId>, begins_with(SK,'SERVICE#')",
    hu: ['HU-025', 'HU-055'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`ORG#${c.f.organizationId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'SERVICE#' },
        }),
      ),
  },
  {
    id: 'AP-72',
    grupo: CITAS,
    nombre: 'Agenda del médico en un día',
    prioridad: 'Muy alta',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = DOCTOR#<doctorUserId>#ORG#<organizationId>#<YYYY-MM-DD>',
    hu: ['HU-029'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(2, `DOCTOR#${c.f.doctorUserId}#ORG#${c.f.doctorOrgId}#${c.f.doctorBusyDay}`),
        { index: 'GSI2' },
      ),
  },
  {
    id: 'AP-73',
    grupo: CITAS,
    nombre: 'Agenda en un periodo',
    prioridad: 'Alta',
    op: 'Query ×N',
    indice: 'GSI2',
    clave: 'una consulta por día, en paralelo y paginada',
    hu: ['HU-029'],
    fanout: true,
    run: async (c) => {
      // Una partición por día evita concentrar la semana o el mes entero en una sola.
      const base = new Date(`${c.f.doctorBusyDay}T00:00:00Z`);
      for (let i = 0; i < 5; i++) {
        const d = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
        await c.measure(
          'Query',
          gsiQ(2, `DOCTOR#${c.f.doctorUserId}#ORG#${c.f.doctorOrgId}#${d}`),
          { index: 'GSI2', label: d },
        );
      }
      c.nota('5 días = 5 consultas. El fan-out es lineal y paralelizable; agrupar por semana crearía particiones calientes.');
    },
  },
  {
    id: 'AP-74',
    grupo: CITAS,
    nombre: 'Detalle de una cita',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'APPT#<appointmentId> / META',
    hu: ['HU-028', 'HU-033'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.appointment(c.f.appointmentId) }),
  },
  {
    id: 'AP-75',
    grupo: CITAS,
    nombre: 'Reservar cita sin traslape',
    prioridad: 'Muy alta',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: '1..N items SLOT# con attribute_not_exists(PK) + META + EVT#',
    hu: ['HU-025', 'HU-034'],
    escritura: true,
    run: (c) => {
      const appointmentId = `SBXA${uniq()}`;
      const fecha = '2027-03-15';
      const hora = '09:00';
      // Médico sandbox único por corrida: si reutilizáramos uno fijo, la segunda
      // repetición chocaría consigo misma y la transacción fallaría por un motivo
      // que no es el que este patrón mide. La contención real la prueba la carga.
      const doctorSandbox = `SBXDOC${uniq()}`;
      const dur = 30;
      const inicioISO = `${fecha}T${hora}:00.000Z`;
      const slots = slotsFor(hora, dur);
      c.nota(`Rejilla de 5 min: una cita de ${dur} min bloquea ${slots.length} items SLOT# en la misma transacción.`);
      return c.measure('TransactWriteItems', {
        TransactItems: [
          ...slots.map((b) => ({
            Put: {
              TableName: T,
              Item: { ...K.slot(c.f.sandboxOrgId, doctorSandbox, fecha, b), tipo: 'HuecoReservado', appointmentId },
              // Si un solo hueco está tomado, la transacción entera falla.
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          })),
          {
            Put: {
              TableName: T,
              Item: {
                ...K.appointment(appointmentId),
                tipo: 'Cita',
                appointmentId,
                organizationId: c.f.sandboxOrgId,
                patientId: c.f.sandboxPatientId,
                doctorUserId: doctorSandbox,
                estado: 'CONFIRMED',
                inicioISO,
                fecha,
                hora,
                duracionMin: dur,
                ...G.gsi2DoctorDay(doctorSandbox, c.f.sandboxOrgId, fecha, hora, appointmentId),
                ...G.gsi4PatientAppt(c.f.sandboxPatientId, APPT_GROUP.UPCOMING, inicioISO, appointmentId),
              },
            },
          },
          { Put: { TableName: T, Item: { ...K.apptEvent(appointmentId, ahora(), `SBXE${uniq()}`), tipo: 'EventoCita', accion: 'CREADA' } } },
        ],
      });
    },
  },
  {
    id: 'AP-76',
    grupo: CITAS,
    nombre: 'Próximas citas del paciente',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'GSI4',
    clave: "GSI4PK = PATIENT#<patientId>#APPT, begins_with(GSI4SK,'UPCOMING#')",
    hu: ['HU-030'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(4, `PATIENT#${c.f.patientConCitas}#APPT`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'UPCOMING#' },
        }),
        { index: 'GSI4' },
      ),
  },
  {
    id: 'AP-77',
    grupo: CITAS,
    nombre: 'Historial de citas del paciente',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI4',
    clave: "GSI4PK = PATIENT#<patientId>#APPT, begins_with(GSI4SK,'PAST#'), paginado",
    hu: ['HU-031'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(4, `PATIENT#${c.f.patientConCitasPasadas}#APPT`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'PAST#' },
          extra: { ...desc, Limit: 25 },
        }),
        { index: 'GSI4' },
      ),
  },
  {
    id: 'AP-78',
    grupo: CITAS,
    nombre: 'Reprogramar cita',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'borra los SLOT# antiguos, reserva los nuevos, actualiza META y añade EVT#',
    hu: ['HU-026'],
    escritura: true,
    run: async (c) => {
      const appointmentId = `SBXA${uniq()}`;
      const fecha = '2027-04-20';
      const viejo = '09:00';
      const nuevo = '11:30';
      const doctorSandbox = `SBXDOC${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.appointment(appointmentId), tipo: 'Cita', estado: 'CONFIRMED', hora: viejo },
      });
      const viejos = slotsFor(viejo, 30);
      const nuevos = slotsFor(nuevo, 30);
      return c.measure('TransactWriteItems', {
        TransactItems: [
          ...viejos.map((b) => ({ Delete: { TableName: T, Key: K.slot(c.f.sandboxOrgId, doctorSandbox, fecha, b) } })),
          ...nuevos.map((b) => ({
            Put: {
              TableName: T,
              Item: { ...K.slot(c.f.sandboxOrgId, doctorSandbox, fecha, b), tipo: 'HuecoReservado', appointmentId },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          })),
          {
            Update: {
              TableName: T,
              Key: K.appointment(appointmentId),
              UpdateExpression: 'SET hora = :h, GSI2SK = :sk',
              ExpressionAttributeValues: { ':h': nuevo, ':sk': `${nuevo}#${appointmentId}` },
            },
          },
          {
            Put: {
              TableName: T,
              Item: { ...K.apptEvent(appointmentId, ahora(), `SBXE${uniq()}`), tipo: 'EventoCita', accion: 'REPROGRAMADA', horarioAnterior: viejo, horarioNuevo: nuevo, motivo: 'Solicitud del paciente' },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-79',
    grupo: CITAS,
    nombre: 'Cancelar cita',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'condición sobre el estado de origen, libera los SLOT#, reescribe GSI4SK a PAST#',
    hu: ['HU-027'],
    escritura: true,
    run: async (c) => {
      const appointmentId = `SBXA${uniq()}`;
      const fecha = '2027-05-11';
      const hora = '11:00';
      const inicioISO = `${fecha}T${hora}:00.000Z`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.appointment(appointmentId), tipo: 'Cita', estado: 'CONFIRMED', patientId: c.f.sandboxPatientId },
      });
      c.nota('Cancelar no dispara un reembolso implícito: eso exige una regla explícita (HU-059).');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          ...slotsFor(hora, 30).map((b) => ({ Delete: { TableName: T, Key: K.slot(c.f.sandboxOrgId, `SBXDOC${uniq()}`, fecha, b) } })),
          {
            Update: {
              TableName: T,
              Key: K.appointment(appointmentId),
              UpdateExpression: 'SET estado = :c, GSI4SK = :sk, motivo = :m',
              // Sólo se cancela desde un estado permitido.
              ConditionExpression: 'estado IN (:conf, :pend)',
              ExpressionAttributeValues: {
                ':c': 'CANCELLED',
                ':conf': 'CONFIRMED',
                ':pend': 'PENDING_PAYMENT',
                ':sk': G.gsi4PatientAppt(c.f.sandboxPatientId, APPT_GROUP.PAST, inicioISO, appointmentId).GSI4SK,
                ':m': 'Cancelada por el paciente',
              },
            },
          },
          { Put: { TableName: T, Item: { ...K.apptEvent(appointmentId, ahora(), `SBXE${uniq()}`), tipo: 'EventoCita', accion: 'CANCELLED' } } },
        ],
      });
    },
  },
  {
    id: 'AP-80',
    grupo: CITAS,
    nombre: 'Cambiar estado de la cita',
    prioridad: 'Alta',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'UpdateItem con condición sobre la transición permitida + EVT#',
    hu: ['HU-033'],
    escritura: true,
    run: async (c) => {
      const appointmentId = `SBXA${uniq()}`;
      const inicioISO = '2027-06-01T10:00:00.000Z';
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.appointment(appointmentId), tipo: 'Cita', estado: 'CONFIRMED', patientId: c.f.sandboxPatientId },
      });
      c.nota('Cada rol sólo ejecuta transiciones permitidas; el grupo UPCOMING/PAST del GSI4SK se recalcula aquí.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.appointment(appointmentId),
              UpdateExpression: 'SET estado = :nuevo, GSI4SK = :sk',
              ConditionExpression: 'estado = :origen',
              ExpressionAttributeValues: {
                ':nuevo': 'ATTENDED',
                ':origen': 'CONFIRMED',
                ':sk': G.gsi4PatientAppt(c.f.sandboxPatientId, grupoDeEstado('ATTENDED'), inicioISO, appointmentId).GSI4SK,
              },
            },
          },
          { Put: { TableName: T, Item: { ...K.apptEvent(appointmentId, ahora(), `SBXE${uniq()}`), tipo: 'EventoCita', accion: 'ATTENDED' } } },
        ],
      });
    },
  },
  {
    id: 'AP-81',
    grupo: CITAS,
    nombre: 'Historial de cambios de una cita',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: "APPT#<appointmentId>, begins_with(SK,'EVT#'), ascendente",
    hu: ['HU-028'],
    run: (c) =>
      c.measure(
        'Query',
        tablaQ(`APPT#${c.f.appointmentId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'EVT#' },
        }),
      ),
  },
  {
    id: 'AP-82',
    grupo: CITAS,
    nombre: 'Agenda consolidada del tutor',
    prioridad: 'Media',
    op: 'AP-46 → AP-76 ×N',
    indice: 'GSI4',
    clave: 'abanico en paralelo sobre los representados con viewAppointments',
    hu: ['HU-032'],
    fanout: true,
    run: async (c) => {
      const r = await c.measure(
        'Query',
        gsiQ(4, `GUARDIAN#${c.f.guardianUserId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'ACTIVE#' },
        }),
        { index: 'GSI4' },
      );
      const reps = (r.Items ?? []).map((i) => i.patientId ?? i.PK?.replace('PATIENT#', '')).filter(Boolean);
      for (const pid of reps) {
        await c.measure(
          'Query',
          gsiQ(4, `PATIENT#${pid}#APPT`, {
            sk: 'begins_with(#sk, :sk)',
            values: { ':sk': 'UPCOMING#' },
            extra: { Limit: 10 },
          }),
          { index: 'GSI4', label: pid },
        );
      }
      c.nota(`El coste lo fija el peor caso, no el promedio: este tutor tiene ${reps.length} representados activos.`);
    },
  },

  // ═══════════════════ 5.7 Telemedicina e interconsultas ═══════════════════
  {
    id: 'AP-83',
    grupo: TELE,
    nombre: 'Datos de la sala de videoconsulta',
    prioridad: 'Media',
    op: 'GetItem ×2',
    indice: 'Tabla',
    clave: 'APPT#<appointmentId>/META + /ROOM',
    hu: ['HU-035'],
    fanout: true,
    run: async (c) => {
      c.nota('Se valida participante, estado y ventana temporal antes de emitir el token efímero, que no se persiste.');
      await c.measure('GetItem', { TableName: T, Key: K.appointment(c.f.appointmentIdRemota) });
      await c.measure('GetItem', { TableName: T, Key: K.room(c.f.appointmentIdRemota) });
    },
  },
  {
    id: 'AP-84',
    grupo: TELE,
    nombre: 'Crear interconsulta',
    prioridad: 'Baja',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'REFERRAL#<tsISO>#<referralId> con GSI3PK = REFERRAL#<doctorDestinoUserId>',
    hu: ['HU-036'],
    escritura: true,
    run: (c) => {
      const ts = ahora();
      const referralId = `SBXR${uniq()}`;
      c.nota('El chat y los archivos se enrutan a WhatsApp: la plataforma sólo registra estado y conclusión (D-16).');
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.referral(c.f.sandboxPatientId, ts, referralId),
          tipo: 'Interconsulta',
          patientId: c.f.sandboxPatientId,
          organizationId: c.f.sandboxOrgId,
          destinoUserId: c.f.sandboxDoctorUserId,
          estado: 'PENDING',
          tsISO: ts,
          motivo: 'Segunda opinión',
          ...G.gsi3Referral(c.f.sandboxDoctorUserId, ts, referralId),
        },
      });
    },
  },
  {
    id: 'AP-85',
    grupo: TELE,
    nombre: 'Bandeja de interconsultas del receptor',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI3',
    clave: 'GSI3PK = REFERRAL#<doctorUserId> (disperso)',
    hu: ['HU-037'],
    run: (c) =>
      c.measure('Query', gsiQ(3, `REFERRAL#${c.f.referralDoctorUserId}`), { index: 'GSI3' }),
  },
  {
    id: 'AP-86',
    grupo: TELE,
    nombre: 'Aceptar interconsulta',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'estado ACCEPTED + ACCESS# temporal de alcance limitado con expiresAt',
    hu: ['HU-037'],
    escritura: true,
    run: async (c) => {
      const ts = ahora();
      const referralId = `SBXR${uniq()}`;
      const patientId = `SBXP${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.referral(patientId, ts, referralId), tipo: 'Interconsulta', estado: 'PENDING' },
      });
      c.nota('El receptor no obtiene acceso clínico hasta aceptar: el ACCESS# nace aquí, con alcance limitado.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.referral(patientId, ts, referralId),
              UpdateExpression: 'SET estado = :a',
              ConditionExpression: 'estado = :p',
              ExpressionAttributeValues: { ':a': 'ACCEPTED', ':p': 'PENDING' },
            },
          },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.access(patientId, c.f.sandboxOrgId, c.f.sandboxDoctorUserId),
                tipo: 'AccesoMedicoPaciente',
                estado: 'ACTIVE',
                scope: 'NOTAS',
                source: 'INTERCONSULTA',
                expiresAt: '2027-01-01',
                ...G.gsi4DoctorPatients(c.f.sandboxDoctorUserId, c.f.sandboxOrgId, 'ACTIVE', patientId),
              },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-87',
    grupo: TELE,
    nombre: 'Cerrar o rechazar interconsulta',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'guarda la conclusión, elimina GSI3PK y revoca el acceso temporal',
    hu: ['HU-037'],
    escritura: true,
    run: async (c) => {
      const ts = ahora();
      const referralId = `SBXR${uniq()}`;
      const patientId = `SBXP${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.referral(patientId, ts, referralId), tipo: 'Interconsulta', estado: 'ACCEPTED', ...G.gsi3Referral(c.f.sandboxDoctorUserId, ts, referralId) },
      });
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.access(patientId, c.f.sandboxOrgId, c.f.sandboxDoctorUserId), tipo: 'AccesoMedicoPaciente', estado: 'ACTIVE' },
      });
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.referral(patientId, ts, referralId),
              UpdateExpression: 'SET estado = :c, conclusion = :k REMOVE GSI3PK, GSI3SK',
              ExpressionAttributeValues: { ':c': 'CLOSED', ':k': 'Se sugiere control en 3 meses' },
            },
          },
          {
            Update: {
              TableName: T,
              Key: K.access(patientId, c.f.sandboxOrgId, c.f.sandboxDoctorUserId),
              UpdateExpression: 'SET estado = :r REMOVE GSI4PK, GSI4SK',
              ExpressionAttributeValues: { ':r': 'REVOKED' },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-88',
    clinico: true,
    grupo: TELE,
    nombre: 'Interconsultas de un paciente',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = PATIENT#<p>#ORG#<o>#REFERRAL, descendente',
    hu: ['HU-014'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(2, `PATIENT#${c.f.referralPatientId}#ORG#${c.f.referralOrgId}#REFERRAL`, { extra: desc }),
        { index: 'GSI2' },
      ),
  },

  // ═══════════════════ 5.8 Recetas electrónicas ═══════════════════
  {
    id: 'AP-89',
    grupo: RECETAS,
    nombre: 'Emitir receta',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'RX# con attribute_not_exists + UNIQ#RXCODE#<codigo> + RXEVT#',
    hu: ['HU-038'],
    escritura: true,
    run: (c) => {
      const ts = ahora();
      const prescriptionId = `SBXRX${uniq()}`;
      const codigo = `SBX${uniq()}`.toUpperCase();
      c.nota('Inmutable tras emitirse: la corrección exige cancelar y emitir otra (D-16).');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: {
                ...K.rx(c.f.sandboxPatientId, ts, prescriptionId),
                tipo: 'Receta',
                patientId: c.f.sandboxPatientId,
                organizationId: c.f.sandboxOrgId,
                doctorUserId: c.f.sandboxDoctorUserId,
                prescriptionId,
                estado: 'EMITTED',
                codigo,
                leyenda: 'Documento informativo. Sin validez oficial.',
                ...G.gsi2Rx(c.f.sandboxPatientId, c.f.sandboxOrgId, ts, prescriptionId),
                ...G.gsi4DoctorRx(c.f.sandboxDoctorUserId, c.f.sandboxOrgId, ts, prescriptionId),
              },
              ConditionExpression: 'attribute_not_exists(SK)',
            },
          },
          {
            Put: {
              TableName: T,
              // Guarda patientId y tsISO: sin ellos, lo que devuelve AP-91 no
              // permite construir la clave de la receta y verificarla exigiría
              // un Scan. El código público sigue siendo opaco.
              Item: {
                ...K.uniqRxCode(codigo),
                tipo: 'GuardianCodigoReceta',
                prescriptionId,
                patientId: c.f.sandboxPatientId,
                organizationId: c.f.sandboxOrgId,
                tsISO: ts,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          { Put: { TableName: T, Item: { ...K.rxEvent(c.f.sandboxPatientId, prescriptionId, ts), tipo: 'EventoReceta', accion: 'EMITIDA' } } },
        ],
      });
    },
  },
  {
    id: 'AP-90',
    clinico: true,
    grupo: RECETAS,
    nombre: 'Recetas de un paciente',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = PATIENT#<p>#ORG#<o>#RX, descendente y paginado',
    hu: ['HU-039'],
    run: (c) =>
      c.measure(
        'Query',
        gsiQ(2, `PATIENT#${c.f.rxPatientId}#ORG#${c.f.rxOrgId}#RX`, { extra: { ...desc, Limit: 25 } }),
        { index: 'GSI2' },
      ),
  },
  {
    id: 'AP-91',
    grupo: RECETAS,
    nombre: 'Verificar receta por su código',
    prioridad: 'Baja',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'UNIQ#RXCODE#<codigoVerificable>',
    hu: ['HU-038'],
    run: (c) => {
      c.nota('El código no lleva el patientId dentro: verificar una receta no revela a quién pertenece.');
      return c.measure('GetItem', { TableName: T, Key: K.uniqRxCode(c.f.rxCodigo) });
    },
    skip: (f) => (f.rxCodigo ? null : 'El dataset no generó recetas'),
  },
  {
    id: 'AP-92',
    clinico: true,
    grupo: RECETAS,
    nombre: 'Recetas emitidas por un médico en un periodo',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI4',
    clave: 'GSI4PK = DOCTOR#<doctorUserId>#ORG#<organizationId>#RX, GSI4SK between fechas',
    hu: ['HU-040'],
    run: (c) => {
      c.nota('Vive en GSI4 desde que GSI2 pasó a ser el eje clínico del paciente por organización.');
      return c.measure(
        'Query',
        gsiQ(4, `DOCTOR#${c.f.rxDoctorUserId}#ORG#${c.f.rxOrgId}#RX`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': '2026-01-01', ':b': '2027-12-31' },
        }),
        { index: 'GSI4' },
      );
    },
  },
  {
    id: 'AP-93',
    grupo: RECETAS,
    nombre: 'Cancelar receta con motivo',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'condición estado = EMITTED + RXEVT#',
    hu: ['HU-038'],
    escritura: true,
    run: async (c) => {
      const ts = ahora();
      const prescriptionId = `SBXRX${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.rx(c.f.sandboxPatientId, ts, prescriptionId), tipo: 'Receta', estado: 'EMITTED' },
      });
      c.nota('El contenido nunca se reescribe: sólo cambia el estado, y el motivo queda en un evento aparte.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.rx(c.f.sandboxPatientId, ts, prescriptionId),
              UpdateExpression: 'SET estado = :c, motivoCancelacion = :m',
              ConditionExpression: 'estado = :e',
              ExpressionAttributeValues: { ':c': 'CANCELLED', ':e': 'EMITTED', ':m': 'Error en la dosis' },
            },
          },
          { Put: { TableName: T, Item: { ...K.rxEvent(c.f.sandboxPatientId, prescriptionId, ahora()), tipo: 'EventoReceta', accion: 'CANCELADA' } } },
        ],
      });
    },
  },

  // ═══════════════════ 5.9 Botón de pánico ═══════════════════
  {
    id: 'AP-94',
    grupo: PANICO,
    nombre: 'Registrar alerta con deduplicación',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'UNIQ#PANIC#<patientId>#<ventana> + PANIC# con GSI3PK = PANIC#<organizationId>',
    hu: ['HU-041'],
    escritura: true,
    run: (c) => {
      const ts = ahora();
      const alertId = `SBXPN${uniq()}`;
      const patientId = `SBXP${uniq()}`;
      c.nota('Un reintento dentro de la ventana se informa al usuario, no crea una segunda alerta.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { ...K.uniqPanic(patientId, ts.slice(0, 13)), tipo: 'GuardianPanico', alertId }, ConditionExpression: 'attribute_not_exists(PK)' } },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.panic(patientId, ts, alertId),
                tipo: 'AlertaPanico',
                patientId,
                organizationId: c.f.sandboxOrgId,
                alertId,
                estado: 'OPEN',
                tsISO: ts,
                ...G.gsi3Panic(c.f.sandboxOrgId, ts, alertId),
              },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-95',
    grupo: PANICO,
    nombre: 'Bandeja de alertas abiertas del tenant',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'GSI3',
    clave: 'GSI3PK = PANIC#<organizationId> (disperso); requiere panicAlerts.manage',
    hu: ['HU-042'],
    run: (c) => c.measure('Query', gsiQ(3, `PANIC#${c.f.panicOrgId}`, { extra: desc }), { index: 'GSI3' }),
  },
  {
    id: 'AP-96',
    grupo: PANICO,
    nombre: 'Reconocer o cerrar una alerta',
    prioridad: 'Media',
    op: 'UpdateItem condicional',
    indice: 'Tabla',
    clave: 'transición OPEN → ACKNOWLEDGED → CLOSED; al cerrar elimina GSI3PK',
    hu: ['HU-042'],
    escritura: true,
    run: async (c) => {
      const ts = ahora();
      const alertId = `SBXPN${uniq()}`;
      const patientId = `SBXP${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.panic(patientId, ts, alertId), tipo: 'AlertaPanico', estado: 'OPEN', ...G.gsi3Panic(c.f.sandboxOrgId, ts, alertId) },
      });
      c.nota('Cerrar la alerta no afirma que la ayuda fue prestada: sólo registra actor, fecha y notas.');
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.panic(patientId, ts, alertId),
        UpdateExpression: 'SET estado = :c, notas = :n REMOVE GSI3PK, GSI3SK',
        ConditionExpression: 'estado IN (:o, :a)',
        ExpressionAttributeValues: { ':c': 'CLOSED', ':o': 'OPEN', ':a': 'ACKNOWLEDGED', ':n': 'Se contactó al paciente' },
      });
    },
  },
  {
    id: 'AP-97',
    grupo: PANICO,
    nombre: 'Resolver destinatarios de la alerta',
    prioridad: 'Media',
    op: 'AP-47 + GetItem',
    indice: 'Tabla',
    clave: 'tutores con receiveNotifications más los destinatarios configurados en la organización',
    hu: ['HU-041'],
    fanout: true,
    run: async (c) => {
      await c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.guardianPatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'GUARDIAN#USER#' },
        }),
      );
      await c.measure('GetItem', { TableName: T, Key: K.org(c.f.panicOrgId) });
    },
  },

  // ═══════════════════ 5.10 Notificaciones y WhatsApp ═══════════════════
  {
    id: 'AP-98',
    grupo: NOTIF,
    nombre: 'Citas con recordatorio pendiente para una fecha',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI3',
    clave: 'GSI3PK = REMINDER#<organizationId>#<YYYY-MM-DD> (disperso)',
    hu: ['HU-043'],
    run: (c) => {
      c.nota('Un recordatorio lógico por cita (D-14): el índice sólo contiene lo que aún no se ha entregado.');
      c.nota('Acotado por organización: sin tenant era la única colección global del modelo.');
      return c.measure('Query', gsiQ(3, `REMINDER#${c.f.organizationId}#${c.f.remDate}`), { index: 'GSI3' });
    },
  },
  {
    id: 'AP-99',
    grupo: NOTIF,
    nombre: 'Crear envío idempotente',
    prioridad: 'Alta',
    op: 'PutItem condicional',
    indice: 'Tabla',
    clave: 'NOTIF#<idempotencyKey> / META con attribute_not_exists(PK)',
    hu: ['HU-043', 'HU-044'],
    escritura: true,
    run: (c) => {
      const idem = `SBXNK${uniq()}`;
      const ts = ahora();
      c.nota('Un reintento del proveedor no genera un segundo mensaje: la clave idempotente es la propia PK.');
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.notification(idem),
          tipo: 'Notificacion',
          idempotencyKey: idem,
          organizationId: c.f.sandboxOrgId,
          appointmentId: c.f.sandboxAppointmentId,
          canal: 'WHATSAPP',
          evento: 'RECORDATORIO',
          estado: 'SENT',
          intentos: 1,
          tsISO: ts,
          ...G.gsi2OrgNotif(c.f.sandboxOrgId, ts, idem),
          ...G.gsi4ApptNotif(c.f.sandboxAppointmentId, ts, 'WHATSAPP'),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      });
    },
  },
  {
    id: 'AP-100',
    grupo: NOTIF,
    nombre: 'Registrar el resultado del envío',
    prioridad: 'Media',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'providerMessageId, intentos y error sanitizado',
    hu: ['HU-045'],
    escritura: true,
    run: (c) => {
      c.nota('Sólo se guardan estados que el proveedor confirma: no se inventa un DELIVERED que no llegó.');
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.notification(`SBXNK${uniq()}`),
        UpdateExpression: 'SET estado = :e, providerMessageId = :p ADD intentos :uno',
        ExpressionAttributeValues: { ':e': 'DELIVERED', ':p': `msg_${uniq()}`, ':uno': 1 },
      });
    },
  },
  {
    id: 'AP-101',
    grupo: NOTIF,
    nombre: 'Retirar el recordatorio de la bandeja',
    prioridad: 'Media',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'elimina GSI3PK de la cita una vez entregado o agotados los reintentos',
    hu: ['HU-043'],
    escritura: true,
    run: (c) => {
      c.nota('Es lo que mantiene pequeña la partición REMINDER#<fecha>: sale del índice al resolverse.');
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.appointment(`SBXA${uniq()}`),
        UpdateExpression: 'SET recordatorio = :r REMOVE GSI3PK, GSI3SK',
        ExpressionAttributeValues: { ':r': 'ENTREGADO' },
      });
    },
  },
  {
    id: 'AP-102',
    grupo: NOTIF,
    nombre: 'Consultar envíos de la organización',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = ORG#<organizationId>#NOTIF#<YYYY-MM>, una consulta por mes del rango',
    hu: ['HU-045'],
    fanout: true,
    run: async (c) => {
      const desde = '2026-07-01';
      const hasta = '2026-09-30';
      for (const mes of mesesEntre(desde, hasta)) {
        await c.measure(
          'Query',
          gsiQ(2, `ORG#${c.f.organizationId}#NOTIF#${mes}`, { extra: { Limit: 50 } }),
          { index: 'GSI2', label: mes },
        );
      }
      c.nota('Sin el bucket mensual esta partición no deja de crecer: es el hallazgo que motivó el cambio.');
    },
  },
  {
    id: 'AP-103',
    grupo: NOTIF,
    nombre: 'Envíos asociados a una cita',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI4',
    clave: 'GSI4PK = APPT#<appointmentId>#NOTIF',
    hu: ['HU-044'],
    run: (c) =>
      c.measure('Query', gsiQ(4, `APPT#${c.f.notifAppointmentId}#NOTIF`), { index: 'GSI4' }),
    skip: (f) => (f.notifAppointmentId ? null : 'El dataset no generó notificaciones'),
  },
  {
    id: 'AP-104',
    grupo: NOTIF,
    nombre: 'Consultar preferencia y consentimiento de canal',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'USER#<userId> o PATIENT#<patientId> / NOTIFPREF',
    hu: ['HU-043'],
    run: (c) => {
      c.nota('Sin consentimiento vigente no se envía: se comprueba antes de encolar, no después.');
      return c.measure('GetItem', { TableName: T, Key: K.notifPref(`PATIENT#${c.f.patientId}`) });
    },
  },
  {
    id: 'AP-105',
    grupo: NOTIF,
    nombre: 'Resolver el número entrante',
    prioridad: 'Alta',
    op: 'Query + Query',
    indice: 'GSI1',
    clave: 'GSI1PK = CONTACT#WHATSAPP#<e164>; si el dueño es tutor se encadena AP-46',
    hu: ['HU-046'],
    fanout: true,
    run: async (c) => {
      const r = await c.measure('Query', gsiQ(1, `CONTACT#WHATSAPP#${c.f.guardianContacto}`), {
        index: 'GSI1',
      });
      const dueños = (r.Items ?? []).map((i) => i.PK);
      const esTutor = dueños.some((pk) => pk?.startsWith('USER#'));
      if (esTutor) {
        // D-15: un número de tutor no revela nada hasta elegir representado y verificar.
        await c.measure(
          'Query',
          gsiQ(4, `GUARDIAN#${c.f.guardianUserId}`, {
            sk: 'begins_with(#sk, :sk)',
            values: { ':sk': 'ACTIVE#' },
          }),
          { index: 'GSI4' },
        );
        c.nota('El número pertenece a un tutor: hay que pedir selección de representado antes de revelar citas.');
      }
    },
  },
  {
    id: 'AP-106',
    grupo: NOTIF,
    nombre: 'Próxima cita para el bot',
    prioridad: 'Alta',
    op: 'AP-39 → AP-76',
    indice: 'GSI4',
    clave: "begins_with(GSI4SK,'UPCOMING#'), Limit 1",
    hu: ['HU-047'],
    fanout: true,
    run: async (c) => {
      const r = await c.measure('GetItem', { TableName: T, Key: K.uniqUserPatient(c.f.linkedUserId) });
      const pid = r.Item?.patientId ?? c.f.linkedPatientId;
      await c.measure(
        'Query',
        gsiQ(4, `PATIENT#${pid}#APPT`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'UPCOMING#' },
          extra: { Limit: 1 },
        }),
        { index: 'GSI4' },
      );
      c.nota('El bot se limita a lo soportado: nunca devuelve notas, diagnósticos ni documentos clínicos.');
    },
    skip: (f) => (f.linkedUserId ? null : 'El dataset no generó cuentas vinculadas a expediente'),
  },
  {
    id: 'AP-107',
    grupo: NOTIF,
    nombre: 'Confirmar o cancelar desde WhatsApp',
    prioridad: 'Media',
    op: 'AP-80 / AP-79',
    indice: 'Tabla',
    clave: 'con verificación previa de identidad y relación; no confirma sin pago aprobado',
    hu: ['HU-048'],
    escritura: true,
    fanout: true,
    run: async (c) => {
      const appointmentId = `SBXA${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.appointment(appointmentId), tipo: 'Cita', estado: 'CONFIRMED', politicaPago: 'NO_REQUERIDO' },
      });
      await c.measure('GetItem', { TableName: T, Key: K.appointment(appointmentId) });
      c.nota('Si la cita exige pago, la condición sobre politicaPago impide confirmarla sin webhook aprobado.');
      await c.measure('UpdateItem', {
        TableName: T,
        Key: K.appointment(appointmentId),
        UpdateExpression: 'SET estado = :e',
        ConditionExpression: 'estado = :o AND politicaPago = :np',
        ExpressionAttributeValues: { ':e': 'CONFIRMED', ':o': 'CONFIRMED', ':np': 'NO_REQUERIDO' },
      });
    },
  },

  // ═══════════════════ 5.11 Pagos electrónicos ═══════════════════
  {
    id: 'AP-108',
    grupo: PAGOS,
    nombre: 'Consultar configuración de cobro',
    prioridad: 'Media',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'ORG#<organizationId> / PAYSETTINGS; producción exige chargesEnabled',
    hu: ['HU-054', 'HU-055'],
    run: (c) => {
      c.nota('No guarda datos bancarios: sólo el identificador de la cuenta conectada (D-17).');
      return c.measure('GetItem', { TableName: T, Key: K.paySettings(c.f.organizationId) });
    },
  },
  {
    id: 'AP-109',
    grupo: PAGOS,
    nombre: 'Crear orden de pago',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'UNIQ#IDEMP#PAY#<key> + PAY#<paymentId>/META + puntero APPT#/PAY#',
    hu: ['HU-055'],
    escritura: true,
    run: (c) => {
      const paymentId = `SBXPY${uniq()}`;
      const key = uniq();
      const ts = ahora();
      c.nota('El importe y la moneda se fijan en servidor: el cliente no puede alterarlos.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { ...K.uniqIdempPay(key), tipo: 'GuardianIdempotencia', paymentId }, ConditionExpression: 'attribute_not_exists(PK)' } },
          {
            Put: {
              TableName: T,
              Item: {
                ...K.payment(paymentId),
                tipo: 'Pago',
                paymentId,
                organizationId: c.f.sandboxOrgId,
                appointmentId: c.f.sandboxAppointmentId,
                payerUserId: c.f.sandboxUserId,
                estado: 'CREATED',
                importe: 700,
                moneda: 'MXN',
                tsISO: ts,
                ...G.gsi2OrgPay(c.f.sandboxOrgId, ts, paymentId),
                ...G.gsi4Payer(c.f.sandboxUserId, ts, paymentId),
                ...G.gsi3PayPending(c.f.sandboxOrgId, ts, paymentId),
              },
            },
          },
          { Put: { TableName: T, Item: { ...K.apptPayment(c.f.sandboxAppointmentId, paymentId), tipo: 'PunteroPagoCita', paymentId, estado: 'CREATED' } } },
        ],
      });
    },
  },
  {
    id: 'AP-110',
    grupo: PAGOS,
    nombre: 'Registrar la referencia del proveedor',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'UNIQ#PROVIDERPAY#<provider>#<providerPaymentId> + UpdateItem del pago',
    hu: ['HU-056'],
    escritura: true,
    run: (c) => {
      const paymentId = `SBXPY${uniq()}`;
      const providerPaymentId = `pi_sbx${uniq()}`;
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { ...K.uniqProviderPay(c.f.provider, providerPaymentId), tipo: 'GuardianProveedor', paymentId }, ConditionExpression: 'attribute_not_exists(PK)' } },
          {
            Update: {
              TableName: T,
              Key: K.payment(paymentId),
              UpdateExpression: 'SET providerPaymentId = :p, estado = :e',
              ExpressionAttributeValues: { ':p': providerPaymentId, ':e': 'PENDING' },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-111',
    grupo: PAGOS,
    nombre: 'Consultar estado de un pago',
    prioridad: 'Media',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'PAY#<paymentId> / META',
    hu: ['HU-058'],
    run: (c) => c.measure('GetItem', { TableName: T, Key: K.payment(c.f.paymentId) }),
    skip: (f) => (f.paymentId ? null : 'El dataset no generó pagos'),
  },
  {
    id: 'AP-112',
    grupo: PAGOS,
    nombre: 'Pagos de una cita',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "APPT#<appointmentId>, begins_with(SK,'PAY#')",
    hu: ['HU-058', 'HU-061'],
    run: (c) => {
      c.nota('El puntero bajo la partición de la cita evita gastar un GSI en esta relación.');
      return c.measure(
        'Query',
        tablaQ(`APPT#${c.f.paymentAppointmentId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'PAY#' },
        }),
      );
    },
  },
  {
    id: 'AP-113',
    grupo: PAGOS,
    nombre: 'Mis órdenes como pagador',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI4',
    clave: 'GSI4PK = PAYER#<payerUserId>',
    hu: ['HU-058'],
    run: (c) => c.measure('Query', gsiQ(4, `PAYER#${c.f.payerUserId}`, { extra: desc }), { index: 'GSI4' }),
    skip: (f) => (f.payerUserId ? null : 'El dataset no generó pagos'),
  },
  {
    id: 'AP-114',
    grupo: PAGOS,
    nombre: 'Deduplicar el evento de webhook',
    prioridad: 'Alta',
    op: 'PutItem condicional',
    indice: 'Tabla',
    clave: 'WEBHOOK#<provider>#<providerEventId> / META con attribute_not_exists(PK)',
    hu: ['HU-057'],
    escritura: true,
    run: (c) => {
      const providerEventId = `evt_sbx${uniq()}`;
      const ts = ahora();
      c.nota('El ingreso responde rápido y encola en SQS: aquí sólo se decide si el evento ya se vio (D-18).');
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.webhookEvent(c.f.provider, providerEventId),
          tipo: 'EventoWebhook',
          provider: c.f.provider,
          providerEventId,
          estado: 'PENDIENTE',
          tsISO: ts,
          expiraEn: Math.floor(Date.now() / 1000) + 2592000,
          ...G.gsi3WebhookPending(c.f.provider, ts, providerEventId),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      });
    },
  },
  {
    id: 'AP-115',
    grupo: PAGOS,
    nombre: 'Resolver el pago desde el webhook',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'UNIQ#PROVIDERPAY#<provider>#<providerPaymentId>',
    hu: ['HU-057'],
    run: (c) =>
      c.measure('GetItem', {
        TableName: T,
        Key: K.uniqProviderPay(c.f.provider, c.f.providerPaymentId),
        ConsistentRead: true,
      }),
    skip: (f) => (f.providerPaymentId ? null : 'El dataset no generó pagos'),
  },
  {
    id: 'AP-116',
    grupo: PAGOS,
    nombre: 'Transicionar el pago',
    prioridad: 'Alta',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'condición sobre el estado de origen + EVT#',
    hu: ['HU-057'],
    escritura: true,
    run: async (c) => {
      const paymentId = `SBXPY${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.payment(paymentId), tipo: 'Pago', estado: 'PENDING' },
      });
      c.nota('Sólo transiciones válidas actualizan Payment: un evento repetido produce el mismo resultado.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.payment(paymentId),
              UpdateExpression: 'SET estado = :s REMOVE GSI3PK, GSI3SK',
              ConditionExpression: 'estado IN (:c, :p)',
              ExpressionAttributeValues: { ':s': 'SUCCEEDED', ':c': 'CREATED', ':p': 'PENDING' },
            },
          },
          { Put: { TableName: T, Item: { ...K.payEvent(paymentId, ahora(), `SBXPE${uniq()}`), tipo: 'EventoPago', accion: 'SUCCEEDED' } } },
        ],
      });
    },
  },
  {
    id: 'AP-117',
    grupo: PAGOS,
    nombre: 'Liberar la cita tras el pago',
    prioridad: 'Alta',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'PAY → SUCCEEDED y APPT PENDING_PAYMENT → CONFIRMED, ambas condicionales, más EVT#',
    hu: ['HU-061'],
    escritura: true,
    run: async (c) => {
      const paymentId = `SBXPY${uniq()}`;
      const appointmentId = `SBXA${uniq()}`;
      const inicioISO = '2027-07-07T09:00:00.000Z';
      await c.silent('PutItem', { TableName: T, Item: { ...K.payment(paymentId), tipo: 'Pago', estado: 'PENDING' } });
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.appointment(appointmentId), tipo: 'Cita', estado: 'PENDING_PAYMENT', patientId: c.f.sandboxPatientId },
      });
      c.nota('Se aplica una sola vez aunque el usuario no regrese del checkout: la fuente de verdad es el webhook.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: K.payment(paymentId),
              UpdateExpression: 'SET estado = :s',
              ConditionExpression: 'estado = :p',
              ExpressionAttributeValues: { ':s': 'SUCCEEDED', ':p': 'PENDING' },
            },
          },
          {
            Update: {
              TableName: T,
              Key: K.appointment(appointmentId),
              UpdateExpression: 'SET estado = :c, GSI4SK = :sk',
              ConditionExpression: 'estado = :pp',
              ExpressionAttributeValues: {
                ':c': 'CONFIRMED',
                ':pp': 'PENDING_PAYMENT',
                ':sk': G.gsi4PatientAppt(c.f.sandboxPatientId, APPT_GROUP.UPCOMING, inicioISO, appointmentId).GSI4SK,
              },
            },
          },
          { Put: { TableName: T, Item: { ...K.apptEvent(appointmentId, ahora(), `SBXE${uniq()}`), tipo: 'EventoCita', accion: 'CONFIRMADA_POR_PAGO' } } },
        ],
      });
    },
  },
  {
    id: 'AP-118',
    grupo: PAGOS,
    nombre: 'Registrar reembolso',
    prioridad: 'Baja',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'REFUND#<tsISO>#<refundId> + condición sobre el pago',
    hu: ['HU-059'],
    escritura: true,
    run: async (c) => {
      const paymentId = `SBXPY${uniq()}`;
      await c.silent('PutItem', { TableName: T, Item: { ...K.payment(paymentId), tipo: 'Pago', estado: 'SUCCEEDED' } });
      c.nota('Sólo pasa a REFUNDED cuando el proveedor lo confirma: aquí queda en SOLICITADO.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: T, Item: { ...K.refund(paymentId, ahora(), `SBXRF${uniq()}`), tipo: 'Reembolso', importe: 700, moneda: 'MXN', motivo: 'Cancelación con anticipación', estado: 'SOLICITADO' } } },
          {
            Update: {
              TableName: T,
              Key: K.payment(paymentId),
              UpdateExpression: 'SET reembolsoSolicitado = :r',
              ConditionExpression: 'estado = :s',
              ExpressionAttributeValues: { ':r': true, ':s': 'SUCCEEDED' },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-119',
    grupo: PAGOS,
    nombre: 'Conciliar: órdenes pendientes y eventos sin procesar',
    prioridad: 'Baja',
    op: 'Query ×2',
    indice: 'GSI3',
    clave: 'GSI3PK = PAYPENDING#<organizationId> y WEBHOOKPENDING#<provider> (dispersos)',
    hu: ['HU-060'],
    fanout: true,
    run: async (c) => {
      await c.measure('Query', gsiQ(3, `PAYPENDING#${c.f.organizationId}`, { extra: { Limit: 50 } }), { index: 'GSI3' });
      await c.measure('Query', gsiQ(3, `WEBHOOKPENDING#${c.f.provider}`, { extra: { Limit: 50 } }), { index: 'GSI3' });
      c.nota('Permite reintentar procesos internos sin volver a cobrar: nada aquí crea un cargo nuevo.');
    },
  },
  {
    id: 'AP-120',
    grupo: PAGOS,
    nombre: 'Pagos de la organización por periodo',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI2',
    clave: 'GSI2PK = ORG#<organizationId>#PAY#<YYYY-MM>, una consulta por mes del rango',
    hu: ['HU-060'],
    fanout: true,
    run: async (c) => {
      for (const mes of mesesEntre('2026-07-01', '2026-09-30')) {
        await c.measure(
          'Query',
          gsiQ(2, `ORG#${c.f.organizationId}#PAY#${mes}`, { extra: { Limit: 100 } }),
          { index: 'GSI2', label: mes },
        );
      }
    },
  },

  // ═══════════════════ 5.12 Auditoría e indicadores ═══════════════════
  {
    id: 'AP-121',
    grupo: AUDIT,
    nombre: 'Registrar evento de auditoría',
    prioridad: 'Muy alta',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'AUDIT#ORG#<org>#ACTOR#<actorUserId>#<YYYY-MM> / <tsISO>#<eventId> con GSI4PK = AUDIT#ORG#<org>#<fecha>',
    hu: ['HU-050'],
    escritura: true,
    run: (c) => {
      const ts = ahora();
      const eventId = `SBXEV${uniq()}`;
      const fecha = ts.slice(0, 10);
      c.nota('Append-only y sin secretos: ni contraseñas, ni tokens, ni cuerpos clínicos.');
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.audit(c.f.sandboxOrgId, c.f.sandboxUserId, ts, eventId),
          tipo: 'Auditoria',
          actor: c.f.sandboxUserId,
          organizationId: c.f.sandboxOrgId,
          accion: 'EXPEDIENTE_LEIDO',
          recurso: 'PATIENT',
          resultado: 'PERMITIDO',
          correlationId: uniq(),
          tsISO: ts,
          fecha,
          ...G.gsi4AuditOrgDay(c.f.sandboxOrgId, fecha, ts, eventId),
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      });
    },
  },
  {
    id: 'AP-122',
    grupo: AUDIT,
    nombre: 'Auditoría por actor y rango',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: 'AUDIT#ORG#<org>#ACTOR#<actorUserId>#<YYYY-MM>, una consulta por mes del rango',
    hu: ['HU-051'],
    fanout: true,
    run: async (c) => {
      c.nota('La organización va en la CLAVE: antes el recorte lo hacía la aplicación, o sea después de leer eventos ajenos.');
      c.nota('Ser administrador no abre el contenido clínico referenciado (HU-051).');
      // Un actor automático acumula toda su historia bajo una sola PK si no se
      // bucketiza. El precio es una consulta por mes del rango.
      for (const mes of mesesEntre('2026-08-01', '2026-09-30')) {
        await c.measure(
          'Query',
          tablaQ(`AUDIT#ORG#${c.f.organizationId}#ACTOR#${c.f.auditActorId}#${mes}`, { extra: { Limit: 100 } }),
          { label: mes },
        );
      }
    },
  },
  {
    id: 'AP-123',
    grupo: AUDIT,
    nombre: 'Auditoría por organización y día',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'GSI4',
    clave: 'GSI4PK = AUDIT#ORG#<organizationId>#<YYYY-MM-DD>',
    hu: ['HU-052'],
    run: (c) => {
      c.nota('Una partición por día: agrupar el tenant entero concentraría toda su actividad en una sola.');
      return c.measure(
        'Query',
        gsiQ(4, `AUDIT#ORG#${c.f.organizationId}#${c.f.auditDate}`, { extra: { Limit: 100 } }),
        { index: 'GSI4' },
      );
    },
  },
  {
    id: 'AP-124',
    grupo: AUDIT,
    nombre: 'Incrementar contador de indicadores',
    prioridad: 'Media',
    op: 'TransactWriteItems',
    indice: 'Tabla',
    clave: 'SEEN#<eventId> con attribute_not_exists + UpdateItem ADD sobre STATS#<organizationId>',
    hu: ['HU-049'],
    escritura: true,
    run: (c) => {
      const eventId = `SBXEV${uniq()}`;
      c.nota('Disparado por Streams, que puede reintregar un registro: la marca SEEN# lo hace idempotente.');
      return c.measure('TransactWriteItems', {
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: { ...K.statSeen(c.f.sandboxOrgId, eventId), tipo: 'MarcaAgregacion', expiraEn: Math.floor(Date.now() / 1000) + 86400 },
              ConditionExpression: 'attribute_not_exists(SK)',
            },
          },
          {
            Update: {
              TableName: T,
              Key: K.stat(c.f.sandboxOrgId, c.f.hoy, 'CITAS_AGENDADAS'),
              UpdateExpression: 'ADD valor :uno',
              ExpressionAttributeValues: { ':uno': 1 },
            },
          },
          {
            // El agregado mensual se incrementa en la MISMA transacción que el
            // diario: si se calculara aparte, los dos podrían divergir.
            Update: {
              TableName: T,
              Key: K.statRollup(c.f.sandboxOrgId, c.f.hoy.slice(0, 4), c.f.hoy.slice(0, 7), 'CITAS_AGENDADAS'),
              UpdateExpression: 'ADD valor :uno',
              ExpressionAttributeValues: { ':uno': 1 },
            },
          },
        ],
      });
    },
  },
  {
    id: 'AP-125',
    grupo: AUDIT,
    nombre: 'Leer indicadores por periodo',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    nombreLargo: 'Detalle diario de indicadores de un mes',
    clave: "STATS#<organizationId>#<YYYY-MM>, SK between fechas, sin cruzar 'ROLLUP#'",
    hu: ['HU-049'],
    run: (c) => {
      c.nota('Agregación incremental: leer indicadores nunca recorre citas ni pacientes.');
      c.nota('Detalle diario de UN mes. Para periodos largos el dashboard usa AP-138, no este patrón.');
      return c.measure(
        'Query',
        tablaQ(`STATS#${c.f.organizationId}#${c.f.statMes}`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': `${c.f.statMes}-01`, ':b': `${c.f.statMes}-31#~` },
        }),
      );
    },
  },
  {
    id: 'AP-138',
    grupo: AUDIT,
    nombre: 'Indicadores agregados por mes',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: 'STATS#<organizationId>#ROLLUP#<YYYY>, SK between meses',
    hu: ['HU-049'],
    run: (c) => {
      c.nota('Seis meses de detalle diario son ~950 ítems; el mismo periodo agregado son ~36. Una consulta cubre el año.');
      return c.measure(
        'Query',
        tablaQ(`STATS#${c.f.organizationId}#ROLLUP#2026`, {
          sk: '#sk BETWEEN :a AND :b',
          values: { ':a': '2026-01', ':b': '2026-12#~' },
        }),
      );
    },
  },
  {
    id: 'AP-126',
    grupo: AUDIT,
    nombre: 'Archivar auditoría',
    prioridad: 'Baja',
    op: 'Export a S3',
    indice: '—',
    clave: 'exportación continua por Streams antes de que expire el TTL en línea',
    hu: ['HU-053'],
    run: () => {},
    skip: () =>
      'No es un acceso a DynamoDB: es una exportación por Streams a S3. Los ítems bajo retención legal se escriben sin atributo de TTL.',
  },

  // ═══════════ Patrones añadidos tras la auditoría del modelado ═══════════
  // Accesos que las historias exigían y no estaban declarados. Se numeran a
  // continuación en vez de renumerar: los IDs AP- son referencias estables en
  // commits, PRs y código.
  {
    id: 'AP-127',
    grupo: ORGS,
    nombre: 'Listar mis invitaciones pendientes',
    prioridad: 'Media',
    op: 'Query',
    indice: 'GSI4',
    clave: "GSI4PK = INVITE#EMAIL#<emailNorm>, begins_with(GSI4SK,'PENDING#')",
    hu: ['HU-005', 'HU-007a'],
    run: (c) => {
      c.nota('HU-007a: una cuenta sin membresías sigue pudiendo ver sus invitaciones. Antes sólo se resolvían con el token en la mano.');
      return c.measure(
        'Query',
        gsiQ(4, `INVITE#EMAIL#${c.f.inviteEmail}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'PENDING#' },
        }),
        { index: 'GSI4' },
      );
    },
    skip: (f) => (f.inviteEmail ? null : 'El dataset no generó invitaciones'),
  },
  {
    id: 'AP-128',
    grupo: IDENT,
    nombre: 'Leer el estado del alta',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'USER#<userId> / ONBOARDING',
    hu: ['HU-004a', 'HU-001'],
    run: (c) => {
      c.nota('HU-001 exige distinguir "autenticada pero sin alta completa": ese estado necesita un ítem donde vivir.');
      return c.measure('GetItem', { TableName: T, Key: K.onboarding(c.f.onboardingUserId) });
    },
  },
  {
    id: 'AP-129',
    grupo: IDENT,
    nombre: 'Avanzar el alta de forma idempotente',
    prioridad: 'Media',
    op: 'UpdateItem',
    indice: 'Tabla',
    clave: 'USER#<userId> / ONBOARDING con condición sobre el paso de origen',
    hu: ['HU-004a'],
    escritura: true,
    run: async (c) => {
      const userId = `SBXU${uniq()}`;
      await c.silent('PutItem', {
        TableName: T,
        Item: { ...K.onboarding(userId), tipo: 'Onboarding', paso: 'PERFIL', estado: 'EN_CURSO' },
      });
      c.nota('La condición sobre el paso de origen es lo que hace el flujo reanudable e idempotente (HU-004a).');
      return c.measure('UpdateItem', {
        TableName: T,
        Key: K.onboarding(userId),
        UpdateExpression: 'SET paso = :nuevo, actualizadoEn = :t',
        ConditionExpression: 'paso = :origen',
        ExpressionAttributeValues: { ':nuevo': 'AVISO_PRIVACIDAD', ':origen': 'PERFIL', ':t': ahora() },
      });
    },
  },
  {
    id: 'AP-130',
    grupo: EXPEDIENTE,
    nombre: 'Solicitudes de acceso sobre mi expediente',
    prioridad: 'Alta',
    op: 'Query',
    indice: 'Tabla',
    clave: "PATIENT#<patientId>, begins_with(SK,'ACCESS#ORG#')",
    hu: ['HU-018', 'HU-019'],
    run: (c) => {
      c.nota('HU-019 deja resolver el acceso al paciente o al tutor; la bandeja de AP-59 es del tenant y no les sirve.');
      return c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.accessPatientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'ACCESS#ORG#' },
        }),
      );
    },
  },
  {
    id: 'AP-131',
    grupo: PACIENTES,
    nombre: 'Listar las organizaciones de un paciente',
    prioridad: 'Media',
    op: 'Query',
    indice: 'Tabla',
    clave: "PATIENT#<patientId>, begins_with(SK,'ENROLLMENT#ORG#')",
    hu: ['HU-008a', 'HU-011', 'HU-020'],
    run: (c) => {
      c.nota('AP-40 y AP-44 dependían de este recorrido y no estaba declarado; el documento prohíbe implementar accesos sin declarar.');
      return c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.patientId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'ENROLLMENT#ORG#' },
        }),
      );
    },
  },
  {
    id: 'AP-132',
    grupo: PACIENTES,
    nombre: 'Orígenes consolidados de un paciente',
    prioridad: 'Baja',
    op: 'Query',
    indice: 'Tabla',
    clave: "PATIENT#<canonico>, begins_with(SK,'MERGEDFROM#')",
    hu: ['HU-008c', 'HU-014'],
    run: (c) => {
      c.nota('Tras un merge, el expediente es la unión del canónico y sus orígenes. Sin este puntero inverso, AP-51 devolvía un expediente incompleto.');
      return c.measure(
        'Query',
        tablaQ(`PATIENT#${c.f.patientCanonicoId}`, {
          sk: 'begins_with(#sk, :sk)',
          values: { ':sk': 'MERGEDFROM#' },
        }),
      );
    },
  },
  {
    id: 'AP-133',
    grupo: NOTIF,
    nombre: 'Leer el contexto de la conversación de WhatsApp',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'WACONV#<e164> / STATE',
    hu: ['HU-046', 'HU-047', 'HU-048'],
    run: (c) => {
      c.nota('D-15 exige contexto seleccionado y verificación proporcional al riesgo; las Lambdas del bot no tienen estado.');
      return c.measure('GetItem', { TableName: T, Key: K.waConversation(c.f.waE164) });
    },
  },
  {
    id: 'AP-134',
    grupo: NOTIF,
    nombre: 'Fijar el representado y la verificación de la conversación',
    prioridad: 'Alta',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'WACONV#<e164> / STATE con TTL corto',
    hu: ['HU-046'],
    escritura: true,
    run: (c) => {
      c.nota('TTL corto: es sesión, no historial. Al expirar, el bot vuelve a pedir verificación.');
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.waConversation(`+5215${String(Date.now()).slice(-9)}`),
          tipo: 'ConversacionWhatsapp',
          patientIdSeleccionado: c.f.sandboxPatientId,
          paso: 'CONTEXTO_ELEGIDO',
          verificadoHasta: ahora(),
          expiraEn: Math.floor(Date.now() / 1000) + 3600,
        },
      });
    },
  },
  {
    id: 'AP-135',
    grupo: IDENT,
    nombre: 'Versión vigente del aviso de privacidad',
    prioridad: 'Alta',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'CONFIG#PRIVACY / CURRENT, cacheable',
    hu: ['HU-004b'],
    run: (c) => {
      c.nota('HU-004b: "una versión nueva puede requerir renovación". Sin este ítem no había con qué comparar el consentimiento guardado.');
      return c.measure('GetItem', { TableName: T, Key: K.privacyConfig() });
    },
  },
  {
    id: 'AP-136',
    grupo: PANICO,
    nombre: 'Destinatarios configurados de la organización',
    prioridad: 'Media',
    op: 'GetItem',
    indice: 'Tabla',
    clave: 'ORG#<organizationId> / PANICRECIPIENTS',
    hu: ['HU-041'],
    run: (c) => {
      c.nota('AP-97 los invocaba pero no existían como entidad declarada.');
      return c.measure('GetItem', { TableName: T, Key: K.panicRecipients(c.f.panicOrgId) });
    },
  },
  {
    id: 'AP-137',
    claveDeterminista: true,
    grupo: PACIENTES,
    nombre: 'Registrar el reto de verificación de un contacto',
    prioridad: 'Media',
    op: 'PutItem',
    indice: 'Tabla',
    clave: 'CONTACTCHK#<canal>#<valor> con TTL',
    hu: ['HU-011a'],
    escritura: true,
    run: (c) => {
      const valor = `+5215${String(Date.now()).slice(-9)}`;
      c.nota('HU-011a: un WhatsApp nuevo se verifica ANTES de usarse, y el reto pendiente necesita dónde vivir.');
      return c.measure('PutItem', {
        TableName: T,
        Item: {
          ...K.contactChallenge(`PATIENT#${c.f.sandboxPatientId}`, 'WHATSAPP', valor),
          tipo: 'RetoContacto',
          canal: 'WHATSAPP',
          valor,
          intentos: 0,
          expiraEn: Math.floor(Date.now() / 1000) + 900,
          estado: 'PENDIENTE',
        },
        // El valor del contacto hace la clave determinista: sin esta alternativa,
        // un reto caducado o fallido bloquearía la verificación de ese número
        // para siempre. Reemitir es justo lo que el usuario espera.
        ConditionExpression:
          'attribute_not_exists(SK) OR estado IN (:exp, :fail)',
        ExpressionAttributeValues: { ':exp': 'EXPIRADO', ':fail': 'FALLIDO' },
      });
    },
  },
];

export const byId = Object.fromEntries(PATTERNS.map((p) => [p.id, p]));
