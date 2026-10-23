import { XWAPaths } from '../Types/index.js';
import { decryptMessageNode, generateMessageID, generateProfilePicture } from '../Utils/index.js';
import { getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';

var QueryIds;
(function (QueryIds) {
    QueryIds["JOB_MUTATION"] = "7150902998257522";
    QueryIds["METADATA"] = "6620195908089573";
    QueryIds["UNFOLLOW"] = "7238632346214362";
    QueryIds["FOLLOW"] = "7871414976211147";
    QueryIds["UNMUTE"] = "7337137176362961";
    QueryIds["MUTE"] = "25151904754424642";
    QueryIds["CREATE"] = "6996806640408138";
    QueryIds["ADMIN_COUNT"] = "7130823597031706";
    QueryIds["CHANGE_OWNER"] = "7341777602580933";
    QueryIds["DELETE"] = "8316537688363079";
    QueryIds["DEMOTE"] = "6551828931592903";
})(QueryIds || (QueryIds = {}));

export const makeNewsletterSocket = (config) => {
    const sock = makeGroupsSocket(config);
    const { authState, signalRepository, query, generateMessageTag } = sock;
    const encoder = new TextEncoder();

    const newsletterWMexQuery = async (jid, queryId, content) => (query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'get',
            xmlns: 'w:mex',
            to: S_WHATSAPP_NET,
        },
        content: [
            {
                tag: 'query',
                attrs: { 'query_id': queryId },
                content: encoder.encode(JSON.stringify({
                    variables: {
                        'newsletter_id': jid,
                        ...content
                    }
                }))
            }
        ]
    }));

    const newsletterQuery = async (jid, type, content) => (query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: type,
            xmlns: 'newsletter',
            to: jid,
        },
        content
    }));

    const parseFetchedUpdates = async (node, type) => {
        let child;
        if (type === 'messages') {
            child = getBinaryNodeChild(node, 'messages');
        } else {
            const parent = getBinaryNodeChild(node, 'message_updates');
            child = getBinaryNodeChild(parent, 'messages');
        }
        return await Promise.all(getAllBinaryNodeChildren(child).map(async (messageNode) => {
            messageNode.attrs.from = child?.attrs.jid;
            const views = parseInt(getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count || '0');
            const reactionNode = getBinaryNodeChild(messageNode, 'reactions');
            const reactions = getBinaryNodeChildren(reactionNode, 'reaction')
                .map(({ attrs }) => ({ count: +attrs.count, code: attrs.code }));

            const data = {
                'server_id': messageNode.attrs.server_id,
                views,
                reactions
            };

            if (type === 'messages') {
                const { fullMessage: message, decrypt } = await decryptMessageNode(
                    messageNode,
                    authState.creds.me.id,
                    authState.creds.me.lid || '',
                    signalRepository,
                    config.logger
                );
                await decrypt();
                data.message = message;
            }
            return data;
        }));
    };

    return {
        ...sock,
        newsletterWMexQuery,
        newsletterQuery,

        subscribeNewsletterUpdates: async (jid) => {
            const result = await newsletterQuery(jid, 'set', [{ tag: 'live_updates', attrs: {}, content: [] }]);
            return getBinaryNodeChild(result, 'live_updates')?.attrs;
        },

        newsletterReactionMode: async (jid, mode) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { settings: { 'reaction_codes': { value: mode } } }
            });
        },

        newsletterUpdateDescription: async (jid, description) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { description: description || '', settings: null }
            });
        },

        newsletterUpdateName: async (jid, name) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { name, settings: null }
            });
        },

        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await generateProfilePicture(content);
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { picture: img.toString('base64'), settings: null }
            });
        },

        newsletterRemovePicture: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { picture: '', settings: null }
            });
        },

        newsletterUnfollow: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.UNFOLLOW);
        },

        newsletterFollow: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.FOLLOW);
        },

        newsletterUnmute: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.UNMUTE);
        },

        newsletterMute: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.MUTE);
        },

        newsletterAction: async (jid, type) => {
            await newsletterWMexQuery(jid, type.toUpperCase());
        },

        newsletterCreate: async (name, description, reaction_codes = 'ALL') => {
            await query({
                tag: 'iq',
                attrs: {
                    to: S_WHATSAPP_NET,
                    xmlns: 'tos',
                    id: generateMessageTag(),
                    type: 'set'
                },
                content: [
                    {
                        tag: 'notice',
                        attrs: {
                            id: '20601218',
                            stage: '5'
                        },
                        content: []
                    }
                ]
            });

            const result = await newsletterWMexQuery(undefined, QueryIds.CREATE, {
                input: {
                    name,
                    description: description || null,
                    settings: {
                        'reaction_codes': {
                            value: reaction_codes.toUpperCase()
                        }
                    }
                }
            });
            return extractNewsletterMetadata(result, true);
        },

        newsletterMetadata: async (type, key, role) => {
            const result = await newsletterWMexQuery(undefined, QueryIds.METADATA, {
                input: {
                    key,
                    type: type.toUpperCase(),
                    'view_role': role || 'GUEST'
                },
                'fetch_viewer_metadata': true,
                'fetch_full_image': true,
                'fetch_creation_time': true
            });
            return extractNewsletterMetadata(result);
        },

        newsletterAdminCount: async (jid) => {
            const result = await newsletterWMexQuery(jid, QueryIds.ADMIN_COUNT);
            const buff = getBinaryNodeChild(result, 'result')?.content?.toString();
            const adminPath = (XWAPaths && XWAPaths.ADMIN_COUNT) || 'xwa2_newsletter_admin';
            return JSON.parse(buff).data[adminPath].admin_count;
        },

        newsletterChangeOwner: async (jid, user) => {
            await newsletterWMexQuery(jid, QueryIds.CHANGE_OWNER, {
                'user_id': user
            });
        },

        newsletterDemote: async (jid, user) => {
            await newsletterWMexQuery(jid, QueryIds.DEMOTE, {
                'user_id': user
            });
        },

        newsletterDelete: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.DELETE);
        },

        newsletterReactMessage: async (jid, serverId, code) => {
            await query({
                tag: 'message',
                attrs: {
                    to: jid,
                    ...(!code ? { edit: '7' } : {}),
                    type: 'reaction',
                    'server_id': String(serverId),
                    id: generateMessageID()
                },
                content: [
                    {
                        tag: 'reaction',
                        attrs: code ? { code } : {}
                    }
                ]
            });
        },

        newsletterFetchMessages: async (type, key, count, after) => {
            const result = await newsletterQuery(S_WHATSAPP_NET, 'get', [
                {
                    tag: 'messages',
                    attrs: {
                        type,
                        ...(type === 'invite' ? { key } : { jid: key }),
                        count: count.toString(),
                        after: after?.toString() || '100'
                    }
                }
            ]);
            return await parseFetchedUpdates(result, 'messages');
        },

        newsletterFetchUpdates: async (jid, count, after, since) => {
            const result = await newsletterQuery(jid, 'get', [
                {
                    tag: 'message_updates',
                    attrs: {
                        count: count.toString(),
                        after: after?.toString() || '100',
                        since: since?.toString() || '0'
                    }
                }
            ]);
            return await parseFetchedUpdates(result, 'updates');
        }
    };
};

export const extractNewsletterMetadata = (node, isCreate) => {
    const result = getBinaryNodeChild(node, 'result')?.content?.toString();
    if (!result) return null;

    const parsed = JSON.parse(result).data;
    if (!parsed) return null;

    const createPath = (XWAPaths && XWAPaths.CREATE) || 'xwa2_newsletter_create';
    const newsletterPath = (XWAPaths && XWAPaths.NEWSLETTER) || 'xwa2_newsletter';

    const info = parsed[isCreate ? createPath : newsletterPath];
    if (!info) return null;

    const thread = info.thread_metadata || {};
    const viewer = info.viewer_metadata || {};

    return {
        id: info.id,
        state: info.state?.type,
        'creation_time': +(thread.creation_time ?? 0),
        name: thread.name?.text,
        nameTime: +(thread.name?.update_time ?? 0),
        description: thread.description?.text,
        descriptionTime: +(thread.description?.update_time ?? 0),
        invite: thread.invite,
        handle: thread.handle,
        picture: thread.picture?.direct_path || null,
        preview: thread.preview?.direct_path || null,
        'reaction_codes': thread.settings?.reaction_codes?.value || 'ALL',
        subscribers: +(thread.subscribers_count || 0),
        verification: thread.verification,
        'viewer_metadata': viewer
    };
};
