"use strict"

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod }
}

Object.defineProperty(exports, "__esModule", { value: true })

const node_cache_1 = __importDefault(require("@cacheable/node-cache"))
const boom_1 = require("@hapi/boom")
const crypto_1 = require("crypto")
const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const Utils_1 = require("../Utils")
const Types_1 = require("../Types")
const WABinary_1 = require("../WABinary")
const WAUSync_1 = require("../WAUSync")
const newsletter_1 = require("./newsletter")
const link_preview_1 = require("../Utils/link-preview")
var ListType = WAProto_1.proto.Message.ListMessage.ListType;
const makeMessagesSocket = (config) => {
    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: axiosOptions, patchMessageBeforeSending, cachedGroupMetadata, } = config
    const baron = newsletter_1.makeNewsletterSocket(config)
    const { ev, authState, processingMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral, newsletterWMexQuery, executeUSyncQuery } = baron   
    
    const userDevicesCache = config.userDevicesCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    })
    
    let mediaConn
    
    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn
        
        if (!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
            mediaConn = (async () => {
            	
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: WABinary_1.S_WHATSAPP_NET,
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                })
                
                const mediaConnNode = WABinary_1.getBinaryNodeChild(result, 'media_conn')
                
                const node = {
                    hosts: WABinary_1.getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes,
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                }
                
                logger.debug('fetched media conn')
                
                return node
            })()
        }
        
        return mediaConn
    }
    
    /**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
    const sendReceipt = async (jid, participant, messageIds, type) => {
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0],
            },
        }
        
        const isReadReceipt = type === 'read' || type === 'read-self'
        
        if (isReadReceipt) {
            node.attrs.t = Utils_1.unixTimestampSeconds().toString()
        }
        
        if (type === 'sender' && WABinary_1.isJidUser(jid)) {
            node.attrs.recipient = jid
            node.attrs.to = participant
        }
        
        else {
            node.attrs.to = jid
            if (participant) {
                node.attrs.participant = participant
            }
        }
        
        if (type) {
            node.attrs.type = WABinary_1.isJidNewsletter(jid) ? 'read-self' : type
        }
        
        const remainingMessageIds = messageIds.slice(1)
        
        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: 'list',
                    attrs: {},
                    content: remainingMessageIds.map(id => ({
                        tag: 'item',
                        attrs: { id }
                    }))
                }
            ]
        }
        
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
        
        await sendNode(node)
    }
    
    /** Correctly bulk send receipts to multiple chats, participants */
    const sendReceipts = async (keys, type) => {
        const recps = Utils_1.aggregateMessageKeysNotFromMe(keys)
        
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type)
        }
    }
    
    /** Bulk read messages. Keys can be from different chats & participants */
    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings()
        
        // based on privacy settings, we have to change the read type
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
        
        await sendReceipts(keys, readType)
    }
    
    /** Fetch image for groups, user, and newsletter **/
    const profilePictureUrl = async (jid) => {
        if (WABinary_1.isJidNewsletter(jid)) {
        	
    	let node = await newsletterWMexQuery(undefined, Types_1.QueryIds.METADATA, {
           input: {
               key: jid, 
               type: 'JID',
               view_role: 'GUEST'
              },
              fetch_viewer_metadata: true,
              fetch_full_image: true,
              fetch_creation_time: true
          })
          
         let result = WABinary_1.getBinaryNodeChild(node, 'result')?.content?.toString()
         
         let metadata = JSON.parse(result).data[Types_1.XWAPaths.NEWSLETTER]         
         
         return Utils_1.getUrlFromDirectPath(metadata.thread_metadata.picture?.direct_path || '') 
         
        } 
        
        else {       	
            const result = await query({
                tag: 'iq',
                attrs: {
                    target: WABinary_1.jidNormalizedUser(jid),
                    to: WABinary_1.S_WHATSAPP_NET,
                    type: 'get',
                    xmlns: 'w:profile:picture'
                 },
                content: [{ 
                      tag: 'picture', 
                      attrs: { 
                         type: 'image', 
                         query: 'url' 
                      }
                 }]
            })
        
            const child = WABinary_1.getBinaryNodeChild(result, 'picture')
        
            return child?.attrs?.url || null
          }
    }
    
    /** Fetch all the devices we've to send a message to */
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = []
        
        if (!useCache) {
            logger.debug('not using cache for devices')
        }
        
        const toFetch = []
        
        jids = Array.from(new Set(jids))
        
        for (let jid of jids) {
            const user = WABinary_1.jidDecode(jid)?.user
            
            jid = WABinary_1.jidNormalizedUser(jid)
            
            if (useCache) {
                const devices = userDevicesCache.get(user)
                
                if (devices) {
                    deviceResults.push(...devices)
                    logger.trace({ user }, 'using cache for devices')
                }
                
                else {
                    toFetch.push(jid)
                }
            }
            
            else {
                toFetch.push(jid)
            }
        }
        
        if (!toFetch.length) {
            return deviceResults
        }
        
        const query = new WAUSync_1.USyncQuery()
            .withContext('message')
            .withDeviceProtocol()
            
        for (const jid of toFetch) {
            query.withUser(new WAUSync_1.USyncUser().withId(jid))
        }
        
        const result = await executeUSyncQuery(query)
        
        if (result) {
            const extracted = Utils_1.extractDeviceJids(result?.list, authState.creds.me.id, ignoreZeroDevices)
            const deviceMap = {}
            
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || []
                deviceMap[item.user].push(item)
                deviceResults.push(item)
            }
            
            for (const key in deviceMap) {
                userDevicesCache.set(key, deviceMap[key])
            }
        }
        
        return deviceResults
    }
    
    /** Assert Sessions */
    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false
        let jidsRequiringFetch = []
        
        if (force) {
            jidsRequiringFetch = jids
        }
        
        else {
            const addrs = jids.map(jid => (signalRepository.jidToSignalProtocolAddress(jid)))
                
            const sessions = await authState.keys.get('session', addrs)
            
            for (const jid of jids) {
                const signalId = signalRepository
                    .jidToSignalProtocolAddress(jid)
                    
                if (!sessions[signalId]) {
                    jidsRequiringFetch.push(jid)
                }
            }
        }
        
        if (jidsRequiringFetch.length) {
            logger.debug({ jidsRequiringFetch }, 'fetching sessions')
            
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: WABinary_1.S_WHATSAPP_NET,
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: jidsRequiringFetch.map(jid => ({
                            tag: 'user',
                            attrs: { jid },
                        }))
                    }
                ]
            })
            
            await Utils_1.parseAndInjectE2ESessions(result, signalRepository)
            
            didFetchNewSession = true
        }
        
        return didFetchNewSession
    }
    
    /** Send Peer Operation */
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        //TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
        if (!authState.creds.me?.id) {
            throw new boom_1.Boom('Not authenticated')
        }
        
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: WAProto_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        }
        
        const meJid = WABinary_1.jidNormalizedUser(authState.creds.me.id)
        
        const msgId = await relayMessage(meJid, protocolMessage, {
            additionalAttributes: {
                category: 'peer',
                // eslint-disable-next-line camelcase
                push_priority: 'high_force',
            },
        })
        
        return msgId
    }
    
    const createParticipantNodes = async (jids, message, extraAttrs) => {
        const patched = await patchMessageBeforeSending(message, jids)        
        const bytes = Utils_1.encodeWAMessage(patched)
        
        let shouldIncludeDeviceIdentity = false
        
        const nodes = await Promise.all(jids.map(async (jid) => {
            const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes })
            
            if (type === 'pkmsg') {
                shouldIncludeDeviceIdentity = true
            }
            
            const node = {
                tag: 'to',
                attrs: { jid },
                content: [{
                        tag: 'enc',
                        attrs: {
                            v: '2',
                            type,
                            ...extraAttrs || {}
                        },
                        content: ciphertext
                    }]
            }
            
            return node
        }))
        
        return { 
        	nodes, 
            shouldIncludeDeviceIdentity 
        }
    }
    
    const relayMessage = (jid_1, message_1, _a) => __awaiter(void 0, [jid_1, message_1, _a], void 0, function* (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, cachedGroupMetadata, statusJidList }) {
        const meId = authState.creds.me.id;
        let shouldIncludeDeviceIdentity = false;
        const { user, server } = (0, WABinary_1.jidDecode)(jid);
        const statusJid = 'status@broadcast';
        const isGroup = server === 'g.us';
        const isStatus = jid === statusJid;
        const isPrivate = server === 's.whatsapp.net'
        const isLid = server === 'lid';
        const isNewsletter = server === 'newsletter';
        msgId = msgId || (0, Utils_1.generateIOSMessageID)();
        useUserDevicesCache = useUserDevicesCache !== false;
        const participants = [];
        const destinationJid = (!isStatus) ? (0, WABinary_1.jidEncode)(user, isLid ? 'lid' : isGroup ? 'g.us' : isNewsletter ? 'newsletter' : 's.whatsapp.net') : statusJid;
        const binaryNodeContent = [];
        const devices = [];
        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            }
        };
        if (participant) {
            // when the retry request is not for a group
            // only send to the specific device that asked for a retry
            // otherwise the message is sent out to every device that should be a recipient
            if (!isGroup && !isStatus) {
                additionalAttributes = Object.assign(Object.assign({}, additionalAttributes), { 'device_fanout': 'false' });
            }
            const { user, device } = (0, WABinary_1.jidDecode)(participant.jid);
            devices.push({ user, device });
        }
        yield authState.keys.transaction(() => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            const mediaType = getMediaType(message);
            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = yield Promise.all([
                    (() => __awaiter(void 0, void 0, void 0, function* () {
                        let groupData = cachedGroupMetadata ? yield cachedGroupMetadata(jid) : undefined;
                        if (groupData) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
                        }
                        if (!groupData && !isStatus) {
                            groupData = yield groupMetadata(jid);
                        }
                        return groupData;
                    }))(),
                    (() => __awaiter(void 0, void 0, void 0, function* () {
                        if (!participant && !isStatus) {
                            const result = yield authState.keys.get('sender-key-memory', [jid]);
                            return result[jid] || {};
                        }
                        return {};
                    }))()
                ]);
                if (!participant) {
                    const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : [];
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList);
                    }
                           if (!isStatus) {
                        additionalAttributes = {
                            ...additionalAttributes,
                            addressing_mode: (groupData === null || groupData === void 0 ? void 0 : groupData.addressingMode) || 'pn'
                        };
                    }
                    const additionalDevices = yield getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                    devices.push(...additionalDevices);
                }
                // if (!participant) {
                //     const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : [];
                //     if (isStatus && statusJidList) {
                //         participantsList.push(...statusJidList);
                //     }
                //     if (!isStatus) {
                //         additionalAttributes = {
                //             ...additionalAttributes,
                //             addressing_mode: (groupData === null || groupData === void 0 ? void 0 : groupData.addressingMode) || 'pn'
                //         };
                //     }
                //     const additionalDevices = getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                //     devices.push(...additionalDevices);
                // }
                const patched = yield patchMessageBeforeSending(message, devices.map(d => (0, WABinary_1.jidEncode)(d.user, isLid ? 'lid' : 's.whatsapp.net', d.device)));
                const bytes = (0, Utils_1.encodeWAMessage)(patched);
                const { ciphertext, senderKeyDistributionMessage } = yield signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId,
                });
                const senderKeyJids = [];
                // ensure a connection is established with every device
                for (const { user, device } of devices) {
                    const jid = (0, WABinary_1.jidEncode)(user, (groupData === null || groupData === void 0 ? void 0 : groupData.addressingMode) === 'lid' ? 'lid' : 's.whatsapp.net', device);
                   
                    // const jid = (0, WABinary_1.jidEncode)(user, isLid ? 'lid' : 's.whatsapp.net', device);
                    if (!senderKeyMap[jid] || !!participant) {
                        senderKeyJids.push(jid);
                        // store that this person has had the sender keys sent to them
                        senderKeyMap[jid] = true;
                    }
                }
                // if there are some participants with whom the session has not been established
                // if there are, we re-send the senderkey
                if (senderKeyJids.length) {
                    logger.debug({ senderKeyJids }, 'sending new sender key');
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    };
                    yield assertSessions(senderKeyJids, false);
                    const result = yield createParticipantNodes(senderKeyJids, senderKeyMsg, mediaType ? { mediatype: mediaType } : undefined);
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                    participants.push(...result.nodes);
                }
                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: { v: '2', type: 'skmsg' },
                    content: ciphertext
                });
                yield authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });
            }
              else if (isNewsletter) {
                // Message edit
                if ((_a = message.protocolMessage) === null || _a === void 0 ? void 0 : _a.editedMessage) {
                    msgId = (_b = message.protocolMessage.key) === null || _b === void 0 ? void 0 : _b.id;
                    message = message.protocolMessage.editedMessage;
                }
                // Message delete
                if (((_c = message.protocolMessage) === null || _c === void 0 ? void 0 : _c.type) === WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE) {
                    msgId = (_d = message.protocolMessage.key) === null || _d === void 0 ? void 0 : _d.id;
                    message = {};
                }
                const patched = yield patchMessageBeforeSending(message, []);
                const bytes = WAProto_1.proto.Message.encode(patched).finish();
                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: mediaType ? { mediatype: mediaType } : {},
                    content: bytes
                });
            }
            else {
                const { user: meUser, device: meDevice } = (0, WABinary_1.jidDecode)(meId);
                if (!participant) {
                    devices.push({ user });
                    // do not send message to self if the device is 0 (mobile)
                    if (meDevice !== undefined && meDevice !== 0) {
                        devices.push({ user: meUser });
                    }
                    const additionalDevices = yield getUSyncDevices([meId, jid], !!useUserDevicesCache, true);
                    devices.push(...additionalDevices);
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                for (const { user, device } of devices) {
                    const isMe = user === meUser;
                    const jid = (0, WABinary_1.jidEncode)(isMe && isLid ? ((_f = (_e = authState.creds) === null || _e === void 0 ? void 0 : _e.me) === null || _f === void 0 ? void 0 : _f.lid.split(':')[0]) || user : user, isLid ? 'lid' : 's.whatsapp.net', device);
                    if (isMe) {
                        meJids.push(jid);
                    }
                    else {
                        otherJids.push(jid);
                    }
                    allJids.push(jid);
                }
                yield assertSessions(allJids, false);
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = yield Promise.all([
                    createParticipantNodes(meJids, meMsg, mediaType ? { mediatype: mediaType } : undefined),
                    createParticipantNodes(otherJids, message, mediaType ? { mediatype: mediaType } : undefined)
                ]);
                participants.push(...meNodes);
                participants.push(...otherNodes);
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            // if (participants.length) {
            //     binaryNodeContent.push({
            //         tag: 'participants',
            //         attrs: {},
            //         content: participants
            //     });
            // }
             if (participants.length) {
                if (additionalAttributes?.['category'] === 'peer') {
                    const peerNode = participants[0]?.content?.[0]
                    
                    if (peerNode) {
                        binaryNodeContent.push(peerNode) // push only enc
                    }
                }
                
                else {
                    binaryNodeContent.push({
                        tag: 'participants',
                        attrs: {},
                        content: participants
                    })
                }
            }
            const stanza = {
                tag: 'message',
                attrs: Object.assign({ id: msgId, type: isNewsletter ? getTypeMessage(message) : 'text' }, (additionalAttributes || {})),
                content: binaryNodeContent
            };
            // if the participant to send to is explicitly specified (generally retry recp)
            // ensure the message is only sent to that person
            // if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
            if (participant) {
                if ((0, WABinary_1.isJidGroup)(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                }
                else if ((0, WABinary_1.areJidsSameUser)(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid;
                    stanza.attrs.recipient = destinationJid;
                }
                else {
                    stanza.attrs.to = participant.jid;
                }
            }
            else {
                stanza.attrs.to = destinationJid;
            }
            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: (0, Utils_1.encodeSignedDeviceIdentity)(authState.creds.account, true)
                });
                logger.debug({ jid }, 'adding device identity');
            }
            if (additionalNodes && additionalNodes.length > 0) {
                stanza.content.push(...additionalNodes);
            }
            else {
                if (((0, WABinary_1.isJidGroup)(jid) || (0, WABinary_1.isJidUser)(jid)) && ((message === null || message === void 0 ? void 0 : message.viewOnceMessage) ? message === null || message === void 0 ? void 0 : message.viewOnceMessage : (message === null || message === void 0 ? void 0 : message.viewOnceMessageV2) ? message === null || message === void 0 ? void 0 : message.viewOnceMessageV2 : (message === null || message === void 0 ? void 0 : message.viewOnceMessageV2Extension) ? message === null || message === void 0 ? void 0 : message.viewOnceMessageV2Extension : (message === null || message === void 0 ? void 0 : message.ephemeralMessage) ? message === null || message === void 0 ? void 0 : message.ephemeralMessage : (message === null || message === void 0 ? void 0 : message.templateMessage) ? message === null || message === void 0 ? void 0 : message.templateMessage : (message === null || message === void 0 ? void 0 : message.interactiveMessage) ? message === null || message === void 0 ? void 0 : message.interactiveMessage : message === null || message === void 0 ? void 0 : message.buttonsMessage)) {
                    stanza.content.push({
                        tag: 'biz',
                        attrs: {},
                        content: [{
                                tag: 'interactive',
                                attrs: {
                                    type: 'native_flow',
                                    v: '1'
                                },
                                content: [{
                                        tag: 'native_flow',
                                        attrs: { name: 'quick_reply' }
                                    }]
                            }]
                    });
                }
            }
            const buttonType = getButtonType(message);
            // if (buttonType) {
            //     stanza.content.push({
            //         tag: 'biz',
            //         attrs: {},
            //         content: [
            //             {
            //                 tag: buttonType,
            //                 attrs: getButtonArgs(message),
            //             }
            //         ]
            //     });
            //     logger.debug({ jid }, 'adding business node');
            // }
                   if (!isNewsletter && buttonType) {
                            const buttonsNode = getButtonArgs(messages)
                            
                            const resultFilteredButtons = WABinary_1.getBinaryFilteredButtons(additionalNodes ? additionalNodes : [])
                            
                            if (resultFilteredButtons) {
                               stanza.content.push(additionalNodes)
                            }
                            
                            else {
                                stanza.content.push(buttonsNode)
                            }
                        }
                        
                        if (isPrivate) {
                            if (!stanza.content || !Array.isArray(stanza.content)) {
                                stanza.content = []
                            }
                            
                            stanza.content.push({
                                tag: 'bot', 
                                attrs: {
                                    biz_bot: '1'
                                }
                            }) 
                        }
            logger.debug({ msgId }, `sending message to ${participants.length} devices`);
            yield sendNode(stanza);
        }));
        return msgId;
    });
    
    const getTypeMessage = (msg) => {
        if (msg.viewOnceMessage) {
            return getTypeMessage(msg.viewOnceMessage.message);
        }
        else if (msg.viewOnceMessageV2) {
            return getTypeMessage(msg.viewOnceMessageV2.message);
        }
        else if (msg.viewOnceMessageV2Extension) {
            return getTypeMessage(msg.viewOnceMessageV2Extension.message);
        }
        else if (msg.ephemeralMessage) {
            return getTypeMessage(msg.ephemeralMessage.message);
        }
        else if (msg.documentWithCaptionMessage) {
            return getTypeMessage(msg.documentWithCaptionMessage.message);
        }
        else if (msg.reactionMessage) {
            return 'reaction';
        }
        else if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3 || msg.pollUpdateMessage) {
            return 'reaction';
        }
        else if (getMediaType(msg)) {
            return 'media';
        }
        else {
            return 'text';
        }
    };
    
    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image'
        }
        else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video'
        }
        else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio'
        }
        else if (message.contactMessage) {
            return 'vcard'
        }
        else if (message.documentMessage) {
            return 'document'
        }
        else if (message.contactsArrayMessage) {
            return 'contact_array'
        }
        else if (message.liveLocationMessage) {
            return 'livelocation'
        }
        else if (message.stickerMessage) {
            return 'sticker'
        }
        else if (message.listMessage) {
            return 'list'
        }
        else if (message.listResponseMessage) {
            return 'list_response'
        }
        else if (message.buttonsResponseMessage) {
            return 'buttons_response'
        }
        else if (message.orderMessage) {
            return 'order'
        }
        else if (message.productMessage) {
            return 'product'
        }
        else if (message.interactiveResponseMessage) {
            return 'native_flow_response'
        }
        else if (message.groupInviteMessage) {
            return 'url'
        }
    }
    
    const getButtonType = (message) => {
    	if (message.listMessage) {
    	    return 'list'
       }
       else if (message.listResponseMessage) {
            return 'list_response'
        }
        else if (message.buttonsMessage) {
            return 'buttons'
        }
        else if (message.buttonsResponseMessage) {
            return 'buttons_response'
        }
        else if (message.templateMessage) {
        	return 'template'
        }
        else if (message.templateButtonReplyMessage) {
        	return 'template_response'
        }
        else if(message.interactiveMessage) {
        	return 'interactive'
        }
        else if (message.interactiveResponseMessage) {
            return 'interactive_response'
        }
         else if(message.interactiveMessage?.nativeFlowMessage) {
        	return 'native_flow'
        }
    }
    
    const getButtonArgs = (message) => {
        if (message.interactiveMessage?.nativeFlowMessage && message.interactiveMessage.nativeFlowMessage?.buttons?.length > 0 && message.interactiveMessage.nativeFlowMessage.buttons[0].name === 'review_and_pay') {
        	return {
        	    tag: 'biz', 
                attrs: {
                	native_flow_name: 'order_details'
                }
            }
        } else if (message.interactiveMessage?.nativeFlowMessage || message.buttonsMessage) {
            return {
            	tag: 'biz', 
                attrs: {}, 
                content: [{
                	tag: 'interactive', 
                    attrs: {
                    	type: 'native_flow', 
                        v: '1'
                    }, 
                    content: [{
                    	tag: 'native_flow', 
                        attrs: {
                        	name: 'quick_reply'
                        }
                    }]
                }]
            }
        }  else if (message.listMessage) {
            const type = message.listMessage.listType;
            if (!type) {
                throw new boom_1.Boom('Expected list type inside message');
            }
            return { v: '2', type: ListType[type].toLowerCase() };
        // }
        
        
        
        // else if (message.listMessage) {
        //     return {
        //     	tag: 'biz', 
        //         attrs: {}, 
        //         content: [{
        //         	tag: 'list', 
        //             attrs: {
        //             	type: 'product_list', 
        //                 v: '2'
        //             }
        //         }]
        //     }
        } else if (message.templateMessage) {
        	return {
        	    tag: 'biz', 
                attrs: {}, 
                content: [{
                	tag: 'hsm', 
                    attrs: {
                    	tag: 'AUTHENTICATION', 
                        category: ''
                    }
                }]
            }
        }
    }
    
    const getPrivacyTokens = async (jids) => {
        const t = Utils_1.unixTimestampSeconds().toString()
        
        const result = await query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: jids.map(jid => ({
                        tag: 'token',
                        attrs: {
                            jid: WABinary_1.jidNormalizedUser(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        })
        
        return result
    }    
    
    const waUploadToServer = Utils_1.getWAUploadToServer(config, refreshMediaConn)
    
    const waitForMsgMediaUpdate = Utils_1.bindWaitForEvent(ev, 'messages.media-update')
    
    const sendStatusMentions = async (jid, content) => {	    		
       const media = await Utils_1.generateWAMessage(WABinary_1.STORIES_JID, content, {
              upload: await waUploadToServer,
              backgroundColor: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"), 
              font: content.text ? Math.floor(Math.random() * 9) : null
       })

       const additionalNodes = [{
          tag: 'meta',
           attrs: {},
           content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                   tag: 'to',
                   attrs: { jid },
                   content: undefined,
               }],
           }],
       }]

       let Private = WABinary_1.isJidUser(jid)
       let statusJid = Private ? [jid] : (await groupMetadata(jid)).participants.map((num) => num.id)
        
       await relayMessage(WABinary_1.STORIES_JID, media.message, {
           messageId: media.key.id,
           statusJidList: statusJid, 
           additionalNodes,
       })

       let type = Private ? 'statusMentionMessage' : 'groupStatusMentionMessage'   
       
       let msg = await Utils_1.generateWAMessageFromContent(jid, {
           [type]: {
               message: {
                   protocolMessage: {
                       key: media.key,
                       type: 25,
                   },
               },
           },
       }, {})

      await relayMessage(jid, msg.message, {
          additionalNodes: Private ? [{
              tag: 'meta',
              attrs: { is_status_mention: 'true' },
              content: undefined,
          }] : undefined
      }, {})

       return media
   }
   
   const sendAlbumMessage = async (jid, medias, options = {}) => {
     if (typeof jid !== 'string') {
         throw new TypeError(`jid must be string, received: ${jid} (${jid?.constructor?.name})`)
      }
      
     for (const media of medias) {
       if (!media.type || !['image', 'video'].includes(media.type)) {
         throw new TypeError(`medias[i].type must be "image" or "video", received: ${media.type} (${media.type?.constructor?.name})`)
       }
       
       if (!media.data || (!media.data.url && !Buffer.isBuffer(media.data))) {
         throw new TypeError(`medias[i].data must be object with url or buffer, received: ${media.data} (${media.data?.constructor?.name})`)
       }
    }
    
     const timer = !isNaN(options.delay) ? options.delay : 500
     
     delete options.delay
     
     const quotedContext = options.quoted ? {
       contextInfo: {
         remoteJid: options.quoted.key?.remoteJid || '',
         fromMe: options.quoted.key?.fromMe || false,
         stanzaId: options.quoted.key?.id || '',
         participant: options.quoted.key?.participant || options.quoted.key?.remoteJid || '',
         quotedMessage: options.quoted.message || {}
       }
     } : {}
     
     const album = await Utils_1.generateWAMessageFromContent(jid, {
       messageContextInfo: {
          messageSecret: crypto_1.randomBytes(32)
       },
        albumMessage: {
         expectedImageCount: medias.filter(media => media.type === "image").length,
         expectedVideoCount: medias.filter(media => media.type === "video").length,
         ...quotedContext
       }
     }, {})
     
     await relayMessage(album.key.remoteJid, album.message, { messageId: album.key.id })
     
     for (const [index, media] of medias.entries()) {
       const { type, data, caption } = media
       
       const mediaMessage = await Utils_1.generateWAMessage(album.key.remoteJid, {
         [type]: data, caption: caption || "", 
         annotations: options?.annotations, 
       }, { 
         upload: await waUploadToServer
       }) 
       
       mediaMessage.message.messageContextInfo = {
           messageSecret: crypto_1.randomBytes(32),
           messageAssociation: {
           associationType: 1,
           parentMessageKey: album.key
         }
      }
      
       await relayMessage(mediaMessage.key.remoteJid, mediaMessage.message, { messageId: mediaMessage.key.id })
       
       await Utils_1.delay(timer)
     }
     
     return album
    }
    
    return {
        ...baron,
        getPrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        readMessages,
        profilePictureUrl, 
        getUSyncDevices,
        refreshMediaConn,
        waUploadToServer,
        sendStatusMentions,
        sendAlbumMessage, 
        fetchPrivacySettings, 
        createParticipantNodes,   
        sendPeerDataOperationMessage, 
        updateMediaMessage: async (message) => {
            const content = Utils_1.assertMediaContent(message.message)
            const mediaKey = content.mediaKey
            const meId = authState.creds.me.id
            const node = await Utils_1.encryptMediaRetryRequest(message.key, mediaKey, meId)
            let error = undefined
            
            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(async (update) => {
                    const result = update.find(c => c.key.id === message.key.id)
                    if (result) {
                        if (result.error) {
                            error = result.error
                        }
                        
                        else {
                            try {
                                const media = await Utils_1.decryptMediaRetryData(result.media, mediaKey, result.key.id)
                                
                                if (media.result !== WAProto_1.proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = WAProto_1.proto.MediaRetryNotification.ResultType[media.result]
                                    
                                    throw new boom_1.Boom(`Media re-upload failed by device (${resultStr})`, { data: media, statusCode: Utils_1.getStatusCodeForMediaRetry(media.result) || 404 })
                                }
                                
                                content.directPath = media.directPath
                                
                                content.url = Utils_1.getUrlFromDirectPath(content.directPath)
                                
                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
                            }
                            
                            catch (err) {
                                error = err
                            }
                        }
                        
                        return true
                    }
                })
            ])
            
            if (error) {
                throw error
            }
            
            ev.emit('messages.update', [
                { key: message.key, update: { message: message.message } }
            ])
            
            return message
        },
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id
            
            if (typeof content === 'object' &&
                'disappearingMessagesInChat' in content &&
                typeof content['disappearingMessagesInChat'] !== 'undefined' &&
                WABinary_1.isJidGroup(jid)) {
                	
                const { disappearingMessagesInChat } = content
                
                const value = typeof disappearingMessagesInChat === 'boolean' ?
                    (disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) :
                    disappearingMessagesInChat
                    
                await groupToggleEphemeral(jid, value)
            }
            
            else {
            	let mediaHandle
            
                const fullMsg = await Utils_1.generateWAMessage(jid, content, {
                    logger,
                    userJid,
                    getUrlInfo: text => link_preview_1.getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 3000,
                            ...axiosOptions || {}
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview
                            ? waUploadToServer
                            : undefined
                    }),
                    getProfilePicUrl: profilePictureUrl,
                    upload: async (readStream, opts) => {
                        const up = await waUploadToServer(readStream, { ...opts, newsletter: WABinary_1.isJidNewsletter(jid) })
                        mediaHandle = up.handle
                        return up
                    },
                    mediaCache: config.mediaCache,
                    options: config.options,
                
                    messageId: Utils_1.generateIOSMessageID(userJid), 
                    ...options,
                })
                
                const isDeleteMsg = 'delete' in content && !!content.delete;
                const isEditMsg = 'edit' in content && !!content.edit;
                const isPinMsg = 'pin' in content && !!content.pin;
                const isAiMsg = 'ai' in content && !!content.ai;
                const isPollMessage = 'poll' in content && !!content.poll;
                const additionalAttributes = {};
                const additionalNodes = [];
                
               // required for delete
                              if (isDeleteMsg) {
                                  // if the chat is a group, and I am not the author, then delete the message as an admin
                    if (((0, WABinary_1.isJidGroup)((_a = content.delete) === null || _a === void 0 ? void 0 : _a.remoteJid) && !((_b = content.delete) === null || _b === void 0 ? void 0 : _b.fromMe)) || (0, WABinary_1.isJidNewsletter)(jid)) {
                        additionalAttributes.edit = '8';
                    }
                    else {
                        additionalAttributes.edit = '7';
                    }
                              }
                              else if (isEditMsg) {
                                 additionalAttributes.edit = (0, WABinary_1.isJidNewsletter)(jid) ? '3' : '1';
                              }
                              else if (isPinMsg) {
                                  additionalAttributes.edit = '2';
                              }
                              else if (isAiMsg) {
                                  additionalNodes.push({
                                      attrs: {
                                          biz_bot: '1'
                                      },
                                      tag: "bot"
                                  });
                              }
                              else if (isPollMessage) {
                                  additionalNodes.push({
                                      tag: 'meta',
                                      attrs: {
                                          polltype: 'creation'
                                      },
                                  });
                              }
                               if (mediaHandle) {
                    additionalAttributes['media_id'] = mediaHandle
                }
                              if ('cachedGroupMetadata' in options) {
                                  console.warn('cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.');
                              }
                if (options.poll) {
                    additionalNodes.push({
                        tag: 'meta',
                        attrs: {
                            polltype: 'creation'
                        },
                    });
                }
               await relayMessage(jid, fullMsg.message, { messageId: fullMsg.key.id, useCachedGroupMetadata: options.useCachedGroupMetadata, additionalAttributes, statusJidList: options.statusJidList, additionalNodes });
                
                if (config.emitOwnEvents) {
                    process.nextTick(() => {
                        processingMutex.mutex(() => (upsertMessage(fullMsg, 'append')))
                    })
                }
                
                return fullMsg
            }
        }


        
    }
}

module.exports = {
  makeMessagesSocket
}