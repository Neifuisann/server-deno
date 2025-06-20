import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { Logger } from '../utils/logger.ts';

const logger = new Logger('[Supabase]');

export function getSupabaseClient(userJwt: string) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_KEY')!;

    return createClient(supabaseUrl, supabaseKey, {
        global: {
            headers: {
                Authorization: `Bearer ${userJwt}`,
            },
        },
    });
}

export const getUserByEmail = async (
    supabase: SupabaseClient,
    email: string,
): Promise<IUser> => {
    const { data, error } = await supabase.from('users').select(
        '*, language:languages(name), personality:personalities!users_personality_id_fkey(*), device:device_id(is_reset, is_ota, volume)',
    ).eq('email', email);

    logger.debug('data', data, error);

    if (error) {
        throw new Error('Failed to authenticate user');
    }
    return data[0] as IUser;
};

export const getDeviceInfo = async (
    supabase: SupabaseClient,
    userId: string,
): Promise<IDevice | null> => {
    const { data, error } = await supabase.from('devices').select('*').eq(
        'user_id',
        userId,
    )
        .single();
    if (error) return null;
    return data as IDevice;
};

export const composeChatHistory = (data: IConversation[]) => {
    const messages = data.map((chat: IConversation) =>
        `${chat.role} [${new Date(chat.created_at).toISOString()}]: ${chat.content}`
    ).join('\n');

    return messages;
};

export const getChatHistory = async (
    supabase: SupabaseClient,
    userId: string,
    personalityKey: string | null,
    isDoctor: boolean,
): Promise<IConversation[]> => {
    try {
        let query = supabase
            .from('conversations')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(20);

        if (personalityKey) {
            query = query.eq('personality_key', personalityKey);
        }

        // If isDoctor is true, only fetch conversations from the last 2 hours
        if (isDoctor) {
            // Calculate timestamp from 2 hours ago
            const twoHoursAgo = new Date();
            twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);

            // Add timestamp filter to query
            query = query.gte('created_at', twoHoursAgo.toISOString());
        }

        const { data, error } = await query;
        if (error) throw error;
        return data;
    } catch (_e: any) {
        return [];
    }
};

const UserPromptTemplate = (user: IUser) => `
YOU ARE TALKING TO someone whose name is: ${user.supervisee_name} and age is: ${user.supervisee_age} with a personality described as: ${user.supervisee_persona}.

Do not ask for personal information.
Your physical form is in the form of a physical object or a toy.
A person interacts with you by pressing a button, sends you instructions and you must respond in a concise conversational style.
`;

const getDoctorGuidanceHistory = (
    data: IConversation[],
): string => {
    return data?.map((chat: IConversation) => {
        const timestamp = chat.created_at ? new Date(chat.created_at).toLocaleString() : '';
        return `${chat.role} [${timestamp}]: ${chat.content}`;
    }).join('') ?? '';
};

const DoctorGuidelinesPrompt = (chatHistory: IConversation[]) => {
    const doctorGuidanceHistory = getDoctorGuidanceHistory(chatHistory);
    return `
Through their phone, the doctor has given you the following instructions:
${doctorGuidanceHistory}

You must follow these instructions while you interact with the child patient.
    `;
};

const DoctorPromptTemplate = (user: IUser, chatHistory: IConversation[]) => {
    const userMetadata = user.user_info.user_metadata as IDoctorMetadata;
    const doctorName = userMetadata.doctor_name || 'Doctor';
    const hospitalName = userMetadata.hospital_name || 'An amazing hospital';
    const specialization = userMetadata.specialization || 'general medicine';
    const favoritePhrases = userMetadata.favorite_phrases ||
        "You're doing an amazing job";
    const doctorGuidelinesPrompt = DoctorGuidelinesPrompt(chatHistory);

    return `
You are speaking to a child patient under the care of doctor ${doctorName} from hospital or clinic ${hospitalName}. The child may be undergoing procedures such as ${specialization}.
You are a friendly, compassionate toy designed to offer comfort and care. You specialize in calming children and answering any questions with simple, concise and calming explanations.

Doctor's recent guidelines:
${doctorGuidelinesPrompt}

Conversation Guidelines:
- You should engage with the child in a fun and engaging way rather than asking open-ended questions. 
- Gamify it, add fun riddles or games to keep the child engaged.
- Use the doctor's observations from the chat history to make the conversation more engaging and interesting.
- Keep the conversation light, fun and engaging. 
- Add in the doctor's favorite phrases ${favoritePhrases} to make the child feel comfortable and at ease.
`;
};



const getCommonPromptTemplate = (
    chatHistory: string,
    user: IUser,
    timestamp: string,
) => `
Your Voice Description: ${user.personality?.voice_prompt}

Your Character Description: ${user.personality?.character_prompt}

The default language is: ${user.language.name} but you must switch to any other language if the user asks for it.

The current time is: ${timestamp}

This is the chat history.
${chatHistory}
`;

export const createFirstMessage = (
    chatHistory: IConversation[],
    payload: IPayload,
) => {
    const { timestamp } = payload;

    // If no chat history, return null (let the system handle a brand new conversation)
    if (!chatHistory || chatHistory.length === 0) {
        return null;
    }

    // Get the most recent conversation timestamp
    const lastMessageTime = new Date(chatHistory[0].created_at);
    const currentTime = new Date(timestamp);

    // Calculate time difference in minutes
    const timeDiffMinutes = (currentTime.getTime() - lastMessageTime.getTime()) / (1000 * 60);

    if (timeDiffMinutes < 2) {
        // If less than 5 minutes, likely an accidental disconnection
        return `The previous conversation was interrupted just moments ago. Please continue where you left off, maintaining the same context and tone.`;
    } else if (timeDiffMinutes < 60) {
        // If less than an hour
        return `It's been about ${
            Math.round(timeDiffMinutes)
        } minutes since your last conversation. You may continue from where you left off or start something new.`;
    } else if (timeDiffMinutes < 60 * 24) {
        // If less than a day
        const hours = Math.round(timeDiffMinutes / 60);
        return `It's been about ${hours} hour${
            hours > 1 ? 's' : ''
        } since your last conversation. The user just started a new conversation!`;
    } else {
        // If more than a day
        const days = Math.round(timeDiffMinutes / (60 * 24));
        return `Welcome the user back after ${days} day${
            days > 1 ? 's' : ''
        }! It's been a while since your last conversation.`;
    }
};

export const createSystemPrompt = (
    chatHistoryData: IConversation[],
    payload: IPayload,
    currentVolume?: number | null,
): string => {
    const { user, timestamp } = payload;
    const chatHistory = composeChatHistory(chatHistoryData);

    let prompt = '';

    // Add current volume information if available
    if (currentVolume !== undefined && currentVolume !== null) {
        prompt += `[SYSTEM INFO] The current device volume is set to ${currentVolume}%\n`;
    }

    if (user.user_info.user_type === 'doctor') {
        prompt += DoctorPromptTemplate(user, chatHistoryData);
    } else {
        prompt += UserPromptTemplate(user);
    }

    prompt += getCommonPromptTemplate(chatHistory, user, timestamp);

    return prompt;
};

export const addConversation = async (
    supabase: SupabaseClient,
    speaker: 'user' | 'assistant',
    content: string,
    user: IUser,
): Promise<void> => {
    const { error } = await supabase.from('conversations').insert({
        role: speaker,
        content,
        user_id: user.user_id,
        is_sensitive: false,
        personality_key: user.personality?.key,
    });

    if (error) {
        throw new Error('Failed to add conversation');
    }
};

export const updateUserSessionTime = async (
    supabase: SupabaseClient,
    user: IUser,
    sessionTime: number,
): Promise<void> => {
    const { error } = await supabase
        .from('users')
        .update({
            session_time: user.session_time + sessionTime,
        })
        .eq('user_id', user.user_id);

    if (error) throw error;
};
